import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { resolvePageAccess } from './access.ts';
import type { PageAccessRequest } from './access.ts';
import { readFileLimits } from './file-limits.ts';
import type { FileLimits } from './file-limits.ts';

export class FileFault extends Error {
  constructor(
    public code: string,
    public status = 404,
  ) {
    super(code);
  }
}
export type FileReference = { slot: string; file: string };
export type FileIntroduction = FileReference & { author: PageAccessRequest };
type Source = FileIntroduction & { source?: { id: string; page: string; database: string | null } };
export type FilePlan = { destination: string; sources: Source[]; pages: string[]; files: string[] };
function deny(): never {
  throw new FileFault('FILE_UNAVAILABLE');
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validIds = (...ids: string[]) => {
  if (ids.some((id) => !uuid.test(id))) throw new FileFault('INVALID_FILE_REQUEST', 400);
};
const key = (r: FileReference) => r.slot + ':' + r.file;

/** Provider-independent transaction kernel; never calls S3 or accepts client receipts as proof.
 * The caller owns BEGIN/COMMIT for journal/cell composition. */
export class FileBoundary {
  constructor(
    readonly pool: Pool,
    readonly limits: FileLimits = readFileLimits(),
  ) {}

  private async owned(c: Pool | PoolClient, a: PageAccessRequest, file: string) {
    return !!(
      await c.query(
        `SELECT 1 FROM file_upload_intents WHERE file_id=$1 AND workspace_id=$2 AND user_id=$3 AND page_id=$4 AND attach_until>clock_timestamp()`,
        [file, a.workspace, a.user, a.page],
      )
    ).rowCount;
  }
  private sourceRequest(s: Source): PageAccessRequest {
    return {
      key: s.source!.id + ':' + s.author.user,
      workspace: s.author.workspace,
      user: s.author.user,
      session: s.author.session,
      page: s.source!.page,
      ...(s.source!.database ? { rowScope: { database: s.source!.database } } : {}),
    };
  }
  async plan(
    introductions: FileIntroduction[],
    destination: string,
    existingFiles: string[] = [],
  ): Promise<FilePlan> {
    const sources: Source[] = [];
    for (const entry of introductions) {
      validIds(entry.slot, entry.file, entry.author.workspace, destination);
      if (entry.author.page !== destination) deny();
      if (await this.owned(this.pool, entry.author, entry.file)) {
        sources.push(entry);
        continue;
      }
      const candidates = (
        await this.pool.query<{ id: string; page: string; database: string | null }>(
          `SELECT u.id,u.page_id AS page,r.database_id AS database FROM file_usages u
         LEFT JOIN database_rows r ON r.workspace_id=u.workspace_id AND r.page_id=u.page_id
         WHERE u.workspace_id=$1 AND u.file_id=$2 AND (u.slot_kind='block' OR EXISTS(SELECT 1 FROM database_properties p WHERE p.workspace_id=u.workspace_id AND p.id=u.slot_id AND p.deleted_at IS NULL))
         ORDER BY u.id LIMIT $3`,
          [entry.author.workspace, entry.file, this.limits.fileUsages],
        )
      ).rows;
      const options = candidates.map((source) => ({ ...entry, source }));
      const access = await resolvePageAccess(
        this.pool,
        options.map((s) => this.sourceRequest(s)),
      );
      const chosen = options.find((s) => access.has(this.sourceRequest(s).key));
      if (!chosen) deny();
      sources.push(chosen);
    }
    return {
      destination,
      sources,
      pages: [
        ...new Set([destination, ...sources.flatMap((s) => (s.source ? [s.source.page] : []))]),
      ].sort(),
      files: [...new Set([...existingFiles, ...introductions.map((r) => r.file)])].sort(),
    };
  }
  async lock(c: PoolClient, workspace: string, plan: FilePlan, document = false) {
    // Workspace rights changes take the exclusive counterpart; rows take their own lifecycle latch.
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [workspace]);
    await c.query('SELECT database_lock_rows($1,$2::uuid[])', [workspace, plan.pages]);
    // Ordinary pages in deterministic order also fence archive/move and factor/session revocation.
    await c.query(
      document
        ? 'SELECT id FROM pages WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE'
        : "SELECT id FROM pages WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND kind='page' ORDER BY id FOR SHARE",
      [workspace, plan.pages],
    );
    // Cells and the document share the page reference quota, even for disjoint files.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('file-page-quota:'||$1,0))", [
      plan.destination,
    ]);
    if (plan.files.length)
      await c.query(
        // Serialize business writers/GC without waiting for the projection's FK KEY SHARE.
        // File identity keys are immutable here; changes of state/usages still conflict.
        'SELECT id FROM files WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE',
        [workspace, plan.files],
      );
  }
  async authorize(c: PoolClient, plan: FilePlan) {
    const requests = plan.sources.map((s, i) => ({ ...s.author, key: `destination-${i}` }));
    const destinations = await resolvePageAccess(c, requests);
    for (const r of requests) if (destinations.get(r.key)?.level !== 'edit') deny();
    for (const s of plan.sources) {
      if (
        !(
          await c.query(
            "SELECT 1 FROM files WHERE workspace_id=$1 AND id=$2 AND state='ready' AND deleted_at IS NULL",
            [s.author.workspace, s.file],
          )
        ).rowCount
      )
        deny();
      if (!s.source) {
        if (!(await this.owned(c, s.author, s.file))) deny();
        continue;
      }
      if (
        !(
          await c.query(
            `SELECT 1 FROM file_usages u WHERE u.id=$1 AND u.workspace_id=$2 AND u.file_id=$3 AND u.page_id=$4
        AND (u.slot_kind='block' OR EXISTS(SELECT 1 FROM database_properties p WHERE p.workspace_id=u.workspace_id AND p.id=u.slot_id AND p.deleted_at IS NULL))`,
            [s.source.id, s.author.workspace, s.file, s.source.page],
          )
        ).rowCount
      )
        deny();
      const request = this.sourceRequest(s);
      if (!(await resolvePageAccess(c, [request])).has(request.key)) deny();
    }
  }
  async replaceBlocks(
    c: PoolClient,
    workspace: string,
    page: string,
    generation: string,
    revision: number,
    next: FileReference[],
    plan: FilePlan,
  ) {
    const cells = Number(
      (
        await c.query<{ n: string }>(
          "SELECT count(*) n FROM file_usages WHERE workspace_id=$1 AND page_id=$2 AND slot_kind='cell'",
          [workspace, page],
        )
      ).rows[0]!.n,
    );
    if (next.length + cells > this.limits.pageReferences)
      throw new FileFault('FILE_REFERENCE_LIMIT', 413);
    await this.authorize(c, plan);
    const before = (
      await c.query<{ slot: string; file: string }>(
        "SELECT slot_id AS slot,file_id AS file FROM file_usages WHERE workspace_id=$1 AND page_id=$2 AND slot_kind='block'",
        [workspace, page],
      )
    ).rows;
    const old = new Set(before.map(key)),
      wanted = new Set(next.map(key));
    const introduced = new Set(plan.sources.map(key));
    for (const ref of next) if (!old.has(key(ref)) && !introduced.has(key(ref))) deny();
    for (const ref of before.filter((r) => !wanted.has(key(r))))
      await c.query(
        "DELETE FROM file_usages WHERE workspace_id=$1 AND page_id=$2 AND slot_kind='block' AND slot_id=$3 AND file_id=$4",
        [workspace, page, ref.slot, ref.file],
      );
    for (const ref of next.filter((r) => !old.has(key(r)))) {
      const count = Number(
        (
          await c.query<{ n: string }>(
            'SELECT count(*) AS n FROM file_usages WHERE workspace_id=$1 AND file_id=$2',
            [workspace, ref.file],
          )
        ).rows[0]!.n,
      );
      if (count >= this.limits.fileUsages) throw new FileFault('FILE_USAGE_LIMIT', 413);
      await c.query(
        "INSERT INTO file_usages(workspace_id,file_id,page_id,slot_kind,slot_id,generation,revision) VALUES($1,$2,$3,'block',$4,$5,$6)",
        [workspace, ref.file, page, ref.slot, generation, revision],
      );
    }
  }
  async verifyLedger(
    c: PoolClient,
    page: string,
    generation: string,
    revision: number,
    refs: FileReference[],
  ) {
    const state = (
      await c.query<{ generation: string; revision: string }>(
        'SELECT generation,revision FROM file_ledger_states WHERE page_id=$1',
        [page],
      )
    ).rows[0];
    if (!state && !refs.length) {
      await c.query(
        'INSERT INTO file_ledger_states(page_id,generation,revision) VALUES($1,$2,$3)',
        [page, generation, revision],
      );
      return;
    }
    if (!state || state.generation !== generation || Number(state.revision) !== revision)
      throw new FileFault('FILE_LEDGER_REBUILD_REQUIRED', 409);
    const stored = (
      await c.query<{ slot: string; file: string }>(
        "SELECT slot_id AS slot,file_id AS file FROM file_usages WHERE page_id=$1 AND slot_kind='block'",
        [page],
      )
    ).rows;
    if (JSON.stringify(stored.map(key).sort()) !== JSON.stringify(refs.map(key).sort()))
      throw new FileFault('FILE_LEDGER_REBUILD_REQUIRED', 409);
  }
  async reserve(
    a: PageAccessRequest,
    input: { bytes: number; name: string; idempotency: string; checksum?: string },
  ) {
    validIds(a.workspace, a.page, a.user, input.idempotency);
    if (
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > this.limits.maxBytes ||
      !input.name ||
      input.name.length > 255 ||
      /[\r\n]/.test(input.name) ||
      input.name.includes(String.fromCharCode(0))
    )
      throw new FileFault('INVALID_FILE_REQUEST', 413);
    const hash = createHash('sha256')
      .update(
        JSON.stringify([a.workspace, a.page, input.bytes, input.name, input.checksum ?? null]),
      )
      .digest('hex');
    return this.transaction(async (c) => {
      const plan: FilePlan = { destination: a.page, sources: [], pages: [a.page], files: [] };
      await this.lock(c, a.workspace, plan);
      if ((await resolvePageAccess(c, [a])).get(a.key)?.level !== 'edit') deny();
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('file-account:'||$1,0))", [
        a.user,
      ]);
      const previous = (
        await c.query<{ file_id: string; request_hash: string }>(
          'SELECT file_id,request_hash FROM file_upload_intents WHERE user_id=$1 AND idempotency_key=$2',
          [a.user, input.idempotency],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== hash) throw new FileFault('IDEMPOTENCY_CONFLICT', 409);
        return previous.file_id;
      }
      const active = Number(
        (
          await c.query<{ n: string }>(
            'SELECT count(*) AS n FROM file_upload_intents WHERE user_id=$1 AND closed_at IS NULL AND expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()',
            [a.user],
          )
        ).rows[0]!.n,
      );
      if (active >= this.limits.activeFiles) throw new FileFault('FILE_CONCURRENCY_LIMIT', 429);
      await c.query(
        'INSERT INTO file_workspace_usage(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',
        [a.workspace],
      );
      const reserved = input.bytes + this.limits.derivativeBytes;
      const admitted = await c.query(
        'UPDATE file_workspace_usage SET reserved_bytes=reserved_bytes+$2,files_count=files_count+1 WHERE workspace_id=$1 AND reserved_bytes+$2<=$3 AND files_count<$4 RETURNING workspace_id',
        [a.workspace, reserved, this.limits.workspaceBytes, this.limits.workspaceFiles],
      );
      if (!admitted.rowCount) throw new FileFault('WORKSPACE_STORAGE_LIMIT', 413);
      const id = randomUUID();
      await c.query(
        "INSERT INTO files(id,workspace_id,object_key,original_name,mime_type,byte_size,state) VALUES($1,$2,$3,$4,'application/octet-stream',$5,'reserved')",
        [id, a.workspace, 'staging/' + randomUUID(), input.name, input.bytes],
      );
      await c.query(
        `INSERT INTO file_upload_intents(file_id,workspace_id,user_id,page_id,idempotency_key,requested_bytes,reserved_bytes,request_hash,expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+$9*interval '1 second',clock_timestamp()+$10*interval '1 second')`,
        [
          id,
          a.workspace,
          a.user,
          a.page,
          input.idempotency,
          input.bytes,
          reserved,
          hash,
          this.limits.resumeSeconds,
          this.limits.absoluteSeconds,
        ],
      );
      return id;
    });
  }
  async admitParts(
    a: PageAccessRequest,
    file: string,
    request: string,
    parts: { number: number; bytes: number; checksum: string }[],
  ) {
    validIds(file, request);
    if (
      !parts.length ||
      parts.length > this.limits.activeParts ||
      new Set(parts.map((p) => p.number)).size !== parts.length
    )
      throw new FileFault('INVALID_PART_PLAN', 400);
    return this.transaction(async (c) => {
      await this.lock(c, a.workspace, {
        destination: a.page,
        sources: [],
        pages: [a.page],
        files: [file],
      });
      if ((await resolvePageAccess(c, [a])).get(a.key)?.level !== 'edit') deny();
      const intent = (
        await c.query<{
          requested_bytes: string;
          transport_mode: string | null;
          whole_checksum: string | null;
        }>(
          `SELECT i.requested_bytes,i.transport_mode,i.whole_checksum FROM file_upload_intents i JOIN files f ON f.workspace_id=i.workspace_id AND f.id=i.file_id WHERE i.file_id=$1 AND i.workspace_id=$2 AND i.user_id=$3 AND i.page_id=$4 AND i.closed_at IS NULL AND i.expires_at>clock_timestamp() AND i.absolute_expires_at>clock_timestamp() AND f.state IN ('reserved','uploading') AND f.deleted_at IS NULL`,
          [file, a.workspace, a.user, a.page],
        )
      ).rows[0];
      if (!intent) deny();
      const total = Number(intent.requested_bytes),
        count = intent.transport_mode === 'post' ? 1 : Math.ceil(total / this.limits.partBytes);
      for (const p of parts)
        if (
          !Number.isInteger(p.number) ||
          p.number < 1 ||
          p.number > count ||
          p.bytes !==
            (intent.transport_mode === 'post'
              ? total
              : Math.min(this.limits.partBytes, total - (p.number - 1) * this.limits.partBytes)) ||
          (intent.transport_mode === 'post' && p.checksum !== intent.whole_checksum) ||
          !/^[A-Za-z0-9+/]{43}=$/.test(p.checksum)
        )
          throw new FileFault('INVALID_PART_PLAN', 400);
      // Short cluster-wide admission mutex, never retained during upload/network I/O.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('file-part-admission',0))");
      const old = (
        await c.query<{
          part_number: number;
          bytes: string;
          checksum: string;
          file_id: string;
          expires_at: Date;
        }>(
          'SELECT * FROM file_part_leases WHERE user_id=$1 AND request_id=$2 ORDER BY part_number',
          [a.user, request],
        )
      ).rows;
      if (old.length) {
        const sorted = [...parts].sort((x, y) => x.number - y.number);
        if (
          old.length !== sorted.length ||
          old.some(
            (r, i) =>
              r.file_id !== file ||
              r.part_number !== sorted[i]!.number ||
              Number(r.bytes) !== sorted[i]!.bytes ||
              r.checksum !== sorted[i]!.checksum,
          )
        )
          throw new FileFault('IDEMPOTENCY_CONFLICT', 409);
        return old.map((r) => r.expires_at);
      }
      const active = (
        await c.query<{ all_count: string; own_count: string }>(
          'SELECT count(*) AS all_count,count(*) FILTER(WHERE user_id=$1) AS own_count FROM file_part_leases WHERE expires_at>clock_timestamp() AND reconciled_at IS NULL',
          [a.user],
        )
      ).rows[0]!;
      if (
        Number(active.all_count) + parts.length > this.limits.instanceParts ||
        Number(active.own_count) + parts.length > this.limits.activeParts
      )
        throw new FileFault('PART_CONCURRENCY_LIMIT', 429);
      // The planned checksum is immutable even after a lease expires or a signature is renewed.
      for (const p of parts)
        if (
          (
            await c.query(
              'SELECT 1 FROM file_part_leases WHERE file_id=$1 AND part_number=$2 AND (checksum<>$3 OR bytes<>$4) LIMIT 1',
              [file, p.number, p.checksum, p.bytes],
            )
          ).rowCount
        )
          throw new FileFault('PART_PLAN_CONFLICT', 409);
      for (const p of parts) {
        const inserted = await c.query(
          'INSERT INTO file_part_plans(file_id,part_number,bytes,checksum) VALUES($1,$2,$3,$4) ON CONFLICT(file_id,part_number) DO UPDATE SET checksum=file_part_plans.checksum WHERE file_part_plans.bytes=EXCLUDED.bytes AND file_part_plans.checksum=EXCLUDED.checksum RETURNING part_number',
          [file, p.number, p.bytes, p.checksum],
        );
        if (!inserted.rowCount) throw new FileFault('PART_PLAN_CONFLICT', 409);
      }
      await c.query(
        'INSERT INTO file_admission_buckets VALUES($1,$2,clock_timestamp()) ON CONFLICT DO NOTHING',
        [a.user, this.limits.burstBytes],
      );
      const bytes = parts.reduce((n, p) => n + p.bytes, 0);
      if (
        !(
          await c.query(
            `UPDATE file_admission_buckets SET tokens=least($2,tokens+greatest(0,extract(epoch FROM clock_timestamp()-updated_at))*$3)-$4,updated_at=clock_timestamp() WHERE user_id=$1 AND least($2,tokens+greatest(0,extract(epoch FROM clock_timestamp()-updated_at))*$3)>=$4 RETURNING user_id`,
            [a.user, this.limits.burstBytes, this.limits.bytesPerSecond, bytes],
          )
        ).rowCount
      )
        throw new FileFault('UPLOAD_ADMISSION_LIMIT', 429);
      const expiry: Date[] = [];
      for (const p of parts)
        expiry.push(
          (
            await c.query<{ expires_at: Date }>(
              `INSERT INTO file_part_leases(user_id,file_id,request_id,part_number,bytes,checksum,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 second') RETURNING expires_at`,
              [a.user, file, request, p.number, p.bytes, p.checksum, this.limits.urlSeconds],
            )
          ).rows[0]!.expires_at,
        );
      return expiry;
    });
  }
  async transaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout='5s'");
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}
