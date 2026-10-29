import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  FileBoundary,
  FileFault,
  readFileLimits,
  resolvePageAccess,
  admitFileCapacity,
  lockFileCapacity,
  reconcileFileCapacity,
} from '@memoria/db';
import type { FileLimits, PageAccessRequest } from '@memoria/db';
import { S3ObjectStorage } from './index.ts';
import type { StorageConfig, StoragePart } from './index.ts';

type Row = {
  file_id: string;
  workspace_id: string;
  page_id: string;
  user_id: string;
  session_id: string | null;
  state: string;
  requested_bytes: string;
  reserved_bytes: string;
  transport_mode: 'post' | 'multipart' | null;
  staging_key: string | null;
  final_key: string | null;
  upload_id: string | null;
  whole_checksum: string | null;
  expires_at: Date;
  absolute_expires_at: Date;
  closed_at: Date | null;
  bytes_verified_at: Date | null;
  object_key: string;
  database_id: string | null;
  job_epoch: string;
  attempts: number;
  last_error: string | null;
  original_name: string;
  detected_mime: string | null;
  preview_status: string;
};
const select = `SELECT i.*,f.state,f.object_key,f.original_name,f.mime_type AS detected_mime,f.preview_status,r.database_id FROM file_upload_intents i JOIN files f ON f.id=i.file_id LEFT JOIN database_rows r ON r.page_id=i.page_id AND r.workspace_id=i.workspace_id`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new FileFault('FILE_UNAVAILABLE');
type PartPlan = { number: number; bytes: number; checksum: string };

/** Durable SQL state machine. S3 is never called inside a SQL transaction.
 * Copies are allocated once per attempt, so a stale worker cannot overwrite a verified object. */
export class UploadService {
  private lastReconciliation = 0;
  readonly boundary: FileBoundary;
  readonly storage: S3ObjectStorage;
  constructor(
    readonly pool: Pool,
    readonly config: StorageConfig,
    readonly limits: FileLimits = readFileLimits(),
  ) {
    this.boundary = new FileBoundary(pool, limits);
    this.storage = new S3ObjectStorage(config);
  }
  close() {
    this.storage.close();
  }
  private async row(id: string, c: Pool | PoolClient = this.pool) {
    if (!uuid.test(id)) throw unavailable();
    const r = (await c.query<Row>(select + ' WHERE i.file_id=$1', [id])).rows[0];
    if (!r) throw unavailable();
    return r;
  }
  private actor(r: Row, session: string): PageAccessRequest {
    return {
      key: r.file_id,
      user: r.user_id,
      session,
      workspace: r.workspace_id,
      page: r.page_id,
      ...(r.database_id ? { rowScope: { database: r.database_id } } : {}),
    };
  }
  async context(user: string, session: string, workspace: string, id: string) {
    const r = await this.row(id);
    if (r.user_id !== user || r.workspace_id !== workspace) throw unavailable();
    return this.actor(r, session);
  }
  private async locked<T>(
    a: PageAccessRequest,
    id: string,
    work: (c: PoolClient, r: Row) => Promise<T>,
    allowExpired = false,
  ) {
    return this.boundary.transaction(async (c) => {
      await this.boundary.lock(c, a.workspace, {
        destination: a.page,
        pages: [a.page],
        files: [id],
        sources: [],
      });
      const r = await this.row(id, c);
      if (
        r.workspace_id !== a.workspace ||
        r.user_id !== a.user ||
        r.page_id !== a.page ||
        (await resolvePageAccess(c, [a])).get(a.key)?.level !== 'edit'
      )
        throw unavailable();
      if (
        !allowExpired &&
        (r.expires_at.getTime() <= Date.now() || r.absolute_expires_at.getTime() <= Date.now())
      )
        throw new FileFault('UPLOAD_EXPIRED', 409);
      return work(c, r);
    });
  }
  private async plans(id: string, c: Pool | PoolClient = this.pool): Promise<PartPlan[]> {
    return (
      await c.query<{ part_number: number; bytes: string; checksum: string }>(
        'SELECT part_number,bytes,checksum FROM file_part_plans WHERE file_id=$1 ORDER BY part_number',
        [id],
      )
    ).rows.map((p) => ({ number: p.part_number, bytes: Number(p.bytes), checksum: p.checksum }));
  }
  async objectLock<T>(
    id: string,
    work: (s: S3ObjectStorage, epoch: string, assertLease: () => void) => Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect(),
      s = new S3ObjectStorage(this.config);
    let lost = false,
      acquired = false;
    const fail = () => {
      lost = true;
      s.close();
    };
    c.on('error', fail);
    let pulse: ReturnType<typeof setInterval> | undefined;
    try {
      acquired = (
        await c.query<{ ok: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended('file-job:'||$1,0)) ok",
          [id],
        )
      ).rows[0]!.ok;
      if (!acquired) throw new FileFault('UPLOAD_BUSY', 409);
      const epoch = (
        await c.query<{ job_epoch: string }>(
          'UPDATE file_upload_intents SET job_epoch=job_epoch+1 WHERE file_id=$1 RETURNING job_epoch',
          [id],
        )
      ).rows[0]!.job_epoch;
      pulse = setInterval(() => {
        void c.query('SELECT 1').catch(fail);
      }, 2000);
      const result = await work(s, epoch, () => {
        if (lost) throw new FileFault('STORAGE_UNAVAILABLE', 503);
      });
      if (lost) throw new FileFault('STORAGE_UNAVAILABLE', 503);
      return result;
    } finally {
      if (pulse) clearInterval(pulse);
      s.close();
      c.off('error', fail);
      if (acquired && !lost)
        await c
          .query("SELECT pg_advisory_unlock(hashtextextended('file-job:'||$1,0))", [id])
          .catch(() => {
            lost = true;
          });
      c.release(lost);
    }
  }
  async initiate(
    a: PageAccessRequest,
    input: { bytes: number; name: string; idempotency: string; checksum: string },
  ) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(input.checksum))
      throw new FileFault('INVALID_FILE_REQUEST', 400);
    const id = await this.boundary.reserve(a, input);
    await this.locked(a, id, async (c, r) => {
      if (!r.transport_mode)
        await c.query(
          'UPDATE file_upload_intents SET transport_mode=$2,staging_key=$3,session_id=$4,whole_checksum=$5 WHERE file_id=$1',
          [
            id,
            input.bytes <= 32 * 1024 ** 2 ? 'post' : 'multipart',
            r.object_key,
            a.session,
            input.checksum,
          ],
        );
    });
    await this.ensureUpload(a, id);
    return this.status(a, id);
  }
  private async ensureUpload(a: PageAccessRequest, id: string) {
    await this.objectLock(id, async (s, epoch) => {
      const r = await this.locked(a, id, async (_c, r) => r);
      if (r.state !== 'reserved') return;
      let upload = r.upload_id;
      if (r.transport_mode === 'multipart' && !upload) {
        const pending = await s.uploads(r.staging_key!);
        if (pending.length > 1) throw new FileFault('UPLOAD_RECONCILIATION_REQUIRED', 409);
        upload = pending[0] ?? (await s.initiate(r.staging_key!));
      }
      await this.locked(a, id, async (c, current) => {
        if (current.job_epoch !== epoch || current.state !== 'reserved')
          throw new FileFault('UPLOAD_STATE_CHANGED', 409);
        await c.query(
          'UPDATE file_upload_intents SET upload_id=$2,session_id=$3 WHERE file_id=$1',
          [id, upload, a.session],
        );
        await c.query("UPDATE files SET state='uploading' WHERE id=$1", [id]);
      });
    });
  }
  private manifest(r: Row, parts: StoragePart[], plan: PartPlan[], complete = false) {
    const total = Number(r.requested_bytes),
      count = Math.ceil(total / this.limits.partBytes);
    if (parts.length > count || new Set(parts.map((p) => p.number)).size !== parts.length)
      throw new FileFault('INVALID_STORAGE_MANIFEST', 409);
    for (const p of parts) {
      const expected = plan.find((v) => v.number === p.number);
      if (
        !expected ||
        p.bytes !== expected.bytes ||
        (p.checksum && p.checksum !== expected.checksum)
      )
        throw new FileFault('INVALID_STORAGE_MANIFEST', 409);
    }
    if (
      complete &&
      (parts.length !== count || plan.length !== count || parts.some((p, i) => p.number !== i + 1))
    )
      throw new FileFault('UPLOAD_INCOMPLETE', 409);
    return parts.map((p) => ({
      ...p,
      checksum: plan.find((v) => v.number === p.number)!.checksum,
    }));
  }
  async status(a: PageAccessRequest, id: string) {
    const r = await this.locked(a, id, async (_c, r) => r, true);
    return {
      id,
      state: r.state,
      bytes: Number(r.requested_bytes),
      mode: r.transport_mode,
      partBytes: this.limits.partBytes,
      expiresAt: r.expires_at.toISOString(),
      bytesVerified: !!r.bytes_verified_at,
      error: r.last_error,
      name: r.original_name,
      checksum: r.whole_checksum,
      preview: r.preview_status,
      mime: r.detected_mime,
    };
  }
  /** No browser manifest: resume discovery is scoped to the authenticated author and page. */
  async pending(a: PageAccessRequest) {
    return this.boundary.transaction(async (c) => {
      await this.boundary.lock(c, a.workspace, {
        destination: a.page,
        pages: [a.page],
        files: [],
        sources: [],
      });
      if ((await resolvePageAccess(c, [a])).get(a.key)?.level !== 'edit') throw unavailable();
      const rows = (
        await c.query<{ id: string; name: string; state: string }>(
          `SELECT f.id,f.original_name AS name,f.state FROM file_upload_intents i JOIN files f ON f.id=i.file_id
         WHERE i.workspace_id=$1 AND i.page_id=$2 AND i.user_id=$3 AND i.expires_at>clock_timestamp() AND i.absolute_expires_at>clock_timestamp()
         AND f.state IN ('reserved','uploading','completing','validating','ready')
         AND NOT EXISTS(SELECT 1 FROM file_usages u WHERE u.file_id=f.id) ORDER BY i.created_at DESC LIMIT 20`,
          [a.workspace, a.page, a.user],
        )
      ).rows;
      return { items: rows };
    });
  }
  async resume(a: PageAccessRequest, id: string) {
    await this.ensureUpload(a, id);
    const r = await this.locked(a, id, async (_c, r) => r);
    if (r.state !== 'uploading') return { ...(await this.status(a, id)), parts: [] };
    const plan = await this.plans(id);
    const parts =
      r.transport_mode === 'multipart'
        ? this.manifest(r, await this.storage.parts(r.staging_key!, r.upload_id!), plan)
        : [];
    await this.locked(a, id, async (c, current) => {
      if (current.state !== 'uploading') throw new FileFault('UPLOAD_STATE_CHANGED', 409);
      if (parts.length)
        await c.query(
          'UPDATE file_part_leases SET reconciled_at=clock_timestamp() WHERE file_id=$1 AND part_number=ANY($2::int[])',
          [id, parts.map((p) => p.number)],
        );
      await c.query(
        "UPDATE file_upload_intents SET session_id=$2,expires_at=least(absolute_expires_at,clock_timestamp()+$3*interval '1 second') WHERE file_id=$1",
        [id, a.session, this.limits.resumeSeconds],
      );
    });
    return {
      ...(await this.status(a, id)),
      parts: parts.map((p) => ({ number: p.number, bytes: p.bytes, checksum: p.checksum })),
    };
  }
  async sign(a: PageAccessRequest, id: string, request: string, parts: PartPlan[]) {
    const r = await this.locked(a, id, async (_c, r) => r);
    if (r.state !== 'uploading') throw new FileFault('UPLOAD_STATE_CHANGED', 409);
    // Sequential/browser uploads must release delivered leases before signing more parts.
    // Only the verified provider listing can reconcile them; a client acknowledgement cannot.
    if (r.transport_mode === 'multipart' && r.upload_id) {
      const delivered = this.manifest(
        r,
        await this.storage.parts(r.staging_key!, r.upload_id),
        await this.plans(id),
      );
      if (delivered.length)
        await this.locked(a, id, async (c, current) => {
          if (current.state !== 'uploading') throw new FileFault('UPLOAD_STATE_CHANGED', 409);
          await c.query(
            'UPDATE file_part_leases SET reconciled_at=clock_timestamp() WHERE file_id=$1 AND part_number=ANY($2::int[])',
            [id, delivered.map((p) => p.number)],
          );
        });
    }
    const expiry = await this.boundary.admitParts(a, id, request, parts);
    const signatures = [];
    for (let i = 0; i < parts.length; i++) {
      const seconds = Math.floor((expiry[i]!.getTime() - Date.now()) / 1000);
      if (seconds < 1) throw new FileFault('UPLOAD_LEASE_EXPIRED', 409);
      const p = parts[i]!;
      signatures.push(
        r.transport_mode === 'post'
          ? {
              number: p.number,
              post: await this.storage.createUpload(
                r.staging_key!,
                Number(r.requested_bytes),
                seconds,
              ),
              expiresAt: expiry[i]!.toISOString(),
            }
          : {
              number: p.number,
              ...(await this.storage.signPart(
                r.staging_key!,
                r.upload_id!,
                p.number,
                p.bytes,
                p.checksum,
                seconds,
              )),
              expiresAt: expiry[i]!.toISOString(),
            },
      );
    }
    await this.locked(a, id, async (c, current) => {
      if (current.state !== 'uploading' || expiry.some((e) => e.getTime() <= Date.now()))
        throw new FileFault('UPLOAD_STATE_CHANGED', 409);
      await c.query(
        "UPDATE file_upload_intents SET session_id=$2,expires_at=least(absolute_expires_at,clock_timestamp()+$3*interval '1 second') WHERE file_id=$1",
        [id, a.session, this.limits.resumeSeconds],
      );
    });
    return { id, signatures };
  }
  async complete(a: PageAccessRequest, id: string) {
    await this.locked(a, id, async (c, r) => {
      if (['completing', 'validating', 'ready'].includes(r.state)) {
        if (r.state === 'completing' && r.attempts >= 8)
          await c.query(
            'UPDATE file_upload_intents SET attempts=0,next_attempt_at=clock_timestamp() WHERE file_id=$1',
            [id],
          );
        return;
      }
      if (r.state !== 'uploading') throw new FileFault('UPLOAD_STATE_CHANGED', 409);
      const plan = await this.plans(id, c),
        expected =
          r.transport_mode === 'post'
            ? 1
            : Math.ceil(Number(r.requested_bytes) / this.limits.partBytes);
      if (plan.length !== expected) throw new FileFault('UPLOAD_INCOMPLETE', 409);
      await c.query("UPDATE files SET state='completing' WHERE id=$1", [id]);
      await c.query(
        'UPDATE file_upload_intents SET session_id=$2,next_attempt_at=clock_timestamp(),attempts=0,last_error=NULL WHERE file_id=$1',
        [id, a.session],
      );
    });
    return this.status(a, id);
  }
  async cancel(a: PageAccessRequest, id: string) {
    await this.locked(
      a,
      id,
      async (c, r) => {
        if (r.state === 'deleted') return;
        if (
          r.state === 'ready' ||
          (await c.query('SELECT 1 FROM file_usages WHERE file_id=$1 LIMIT 1', [id])).rowCount
        )
          throw new FileFault('UPLOAD_STATE_CHANGED', 409);
        await c.query("UPDATE files SET state='deleting' WHERE id=$1", [id]);
        await c.query(
          'UPDATE file_upload_intents SET closed_at=coalesce(closed_at,clock_timestamp()),next_attempt_at=clock_timestamp(),last_error=NULL WHERE file_id=$1',
          [id],
        );
      },
      true,
    );
    return this.status(a, id);
  }
  private async verify(s: S3ObjectStorage, r: Row, key: string, plan: PartPlan[]) {
    const expected = Number(r.requested_bytes),
      whole = createHash('sha256');
    let size = 0,
      index = 0,
      partSize = 0,
      part = createHash('sha256');
    for await (const chunk of await s.read(key)) {
      size += chunk.length;
      if (size > expected) throw new FileFault('FILE_BYTES_REJECTED', 422);
      whole.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const p = plan[index];
        if (!p) throw new FileFault('FILE_BYTES_REJECTED', 422);
        const length = Math.min(chunk.length - offset, p.bytes - partSize);
        part.update(chunk.subarray(offset, offset + length));
        partSize += length;
        offset += length;
        if (partSize === p.bytes) {
          if (part.digest('base64') !== p.checksum) throw new FileFault('FILE_BYTES_REJECTED', 422);
          index++;
          partSize = 0;
          part = createHash('sha256');
        }
      }
    }
    const checksum = whole.digest('base64');
    if (size !== expected || index !== plan.length || partSize || checksum !== r.whole_checksum)
      throw new FileFault('FILE_BYTES_REJECTED', 422);
    return Buffer.from(checksum, 'base64').toString('hex');
  }
  /** Called by the worker; one object job at a time per process, durable retries in PG. */
  async tick() {
    if (Date.now() - this.lastReconciliation >= 60000) {
      const check = await reconcileFileCapacity(this.pool);
      if (check.driftWorkspaces)
        console.warn(JSON.stringify({ event: 'file_accounting_drift', ...check }));
      this.lastReconciliation = Date.now();
    }
    await this.orphans();
    await this.pool.query(
      `UPDATE files f SET state='deleting' FROM file_upload_intents i WHERE i.file_id=f.id AND f.state IN ('reserved','uploading','rejected') AND (i.expires_at<=clock_timestamp() OR i.absolute_expires_at<=clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM file_usages u WHERE u.file_id=f.id)`,
    );
    const id = (
      await this.pool.query<{ file_id: string }>(
        `SELECT i.file_id FROM file_upload_intents i JOIN files f ON f.id=i.file_id WHERE (f.state='deleting' OR (f.state='completing' AND i.attempts<8) OR (f.state IN ('validating','ready') AND i.bytes_verified_at IS NOT NULL AND (i.staging_cleaned_at IS NULL OR EXISTS(SELECT 1 FROM file_object_copies o WHERE o.file_id=i.file_id AND o.object_key<>i.final_key AND NOT o.retained AND o.deleted_at IS NULL)))) AND i.next_attempt_at<=clock_timestamp() ORDER BY i.next_attempt_at LIMIT 1`,
      )
    ).rows[0]?.file_id;
    if (!id) return false;
    let claimedEpoch: string | undefined;
    try {
      await this.objectLock(id, async (s, epoch) => {
        claimedEpoch = epoch;
        const r = await this.row(id);
        if (r.state === 'deleting') {
          await this.collect(s, r, epoch);
          return;
        }
        if (['validating', 'ready'].includes(r.state)) {
          await this.cleanStaging(s, r, epoch);
          return;
        }
        if (r.state !== 'completing') return;
        if (!r.session_id) throw new FileFault('FILE_UNAVAILABLE');
        const a = this.actor(r, r.session_id);
        await this.locked(a, id, async () => {});
        const plan = await this.plans(id);
        let head = await s.head(r.staging_key!);
        if (!head && r.transport_mode === 'multipart') {
          const parts = this.manifest(r, await s.parts(r.staging_key!, r.upload_id!), plan, true);
          await s.complete(r.staging_key!, r.upload_id!, parts);
          head = await s.head(r.staging_key!);
        }
        if (!head) throw new FileFault('UPLOAD_INCOMPLETE', 409);
        if (head.bytes !== Number(r.requested_bytes))
          throw new FileFault('FILE_BYTES_REJECTED', 422);
        const key = 'objects/' + randomUUID();
        await this.locked(a, id, async (c, current) => {
          if (current.job_epoch !== epoch || current.state !== 'completing')
            throw new FileFault('UPLOAD_STATE_CHANGED', 409);
          await admitFileCapacity(c, this.limits, {
            reserved: 0,
            staging: 0,
            copies: Number(r.requested_bytes),
          });
          await c.query(
            'INSERT INTO file_object_copies(object_key,file_id,epoch) VALUES($1,$2,$3)',
            [key, id, epoch],
          );
        });
        await s.copy(r.staging_key!, key);
        const hash = await this.verify(s, r, key, plan);
        await this.locked(a, id, async (c, current) => {
          if (current.job_epoch !== epoch || current.state !== 'completing')
            throw new FileFault('UPLOAD_STATE_CHANGED', 409);
          await c.query("UPDATE files SET object_key=$2,sha256=$3,state='validating' WHERE id=$1", [
            id,
            key,
            hash,
          ]);
          await c.query(
            "UPDATE file_upload_intents SET final_key=$2,bytes_verified_at=clock_timestamp(),last_error=NULL,next_attempt_at=greatest(clock_timestamp(),(SELECT max(expires_at)+interval '120 seconds' FROM file_part_leases WHERE file_id=$1)) WHERE file_id=$1",
            [id, key],
          );
          await c.query(
            'UPDATE file_part_leases SET reconciled_at=clock_timestamp() WHERE file_id=$1',
            [id],
          );
        });
      });
    } catch (error) {
      if (error instanceof FileFault && error.code === 'UPLOAD_BUSY') return false;
      const code = error instanceof FileFault ? error.code : 'STORAGE_UNAVAILABLE';
      await this.boundary.transaction(async (c) => {
        await c.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [id]);
        const r = await this.row(id, c);
        if (claimedEpoch && r.job_epoch !== claimedEpoch) return;
        if (
          r.state === 'completing' &&
          ['FILE_BYTES_REJECTED', 'FILE_UNAVAILABLE', 'UPLOAD_EXPIRED'].includes(code)
        ) {
          await c.query("UPDATE files SET state='rejected' WHERE id=$1", [id]);
          await c.query(
            "UPDATE file_upload_intents SET expires_at=clock_timestamp()+$2*interval '1 second',closed_at=clock_timestamp() WHERE file_id=$1",
            [id, this.limits.resumeSeconds],
          );
        } else if (r.state === 'completing' && code === 'UPLOAD_INCOMPLETE')
          await c.query("UPDATE files SET state='uploading' WHERE id=$1", [id]);
        await c.query(
          "UPDATE file_upload_intents SET attempts=attempts+1,last_error=$2,next_attempt_at=clock_timestamp()+least(300,power(2,least(attempts,8))) * interval '1 second' WHERE file_id=$1",
          [id, code],
        );
      });
      console.warn(JSON.stringify({ event: 'file_job_retry', code }));
    }
    return true;
  }
  private async collect(s: S3ObjectStorage, r: Row, epoch: string) {
    await this.boundary.transaction(async (c) => {
      await c.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [r.file_id]);
      const current = await this.row(r.file_id, c);
      if (
        current.state !== 'deleting' ||
        current.job_epoch !== epoch ||
        (await c.query('SELECT 1 FROM file_usages WHERE file_id=$1 LIMIT 1', [r.file_id])).rowCount
      )
        throw new FileFault('FILE_IN_USE', 409);
    });
    // Abort first, then wait for every issued capability and the proxy's 120s body deadline.
    if (r.upload_id)
      await s.abort(r.staging_key!, r.upload_id).catch((e) => {
        if ((e as Error).name !== 'NoSuchUpload') throw e;
      });
    if (r.staging_key)
      for (const upload of await s.uploads(r.staging_key)) await s.abort(r.staging_key, upload);
    const until = (
      await this.pool.query<{ until: Date | null }>(
        "SELECT max(expires_at)+interval '120 seconds' AS until FROM file_part_leases WHERE file_id=$1",
        [r.file_id],
      )
    ).rows[0]!.until;
    if (until && until.getTime() > Date.now()) {
      await this.pool.query(
        'UPDATE file_upload_intents SET next_attempt_at=$2 WHERE file_id=$1 AND job_epoch=$3',
        [r.file_id, until, epoch],
      );
      return;
    }
    const keys = (
      await this.pool.query<{ object_key: string }>(
        'SELECT object_key FROM file_object_copies WHERE file_id=$1 AND deleted_at IS NULL',
        [r.file_id],
      )
    ).rows.map((x) => x.object_key);
    for (const key of new Set(
      [r.staging_key, r.final_key, ...keys].filter((k): k is string => !!k),
    )) {
      await s.delete(key);
      if (await s.head(key)) throw new Error('STORAGE_DELETE_UNCONFIRMED');
    }
    if (r.staging_key && (await s.uploads(r.staging_key)).length)
      throw new Error('STORAGE_DELETE_UNCONFIRMED');
    await this.boundary.transaction(async (c) => {
      await c.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [r.file_id]);
      const current = await this.row(r.file_id, c);
      if (
        current.state !== 'deleting' ||
        current.job_epoch !== epoch ||
        (await c.query('SELECT 1 FROM file_usages WHERE file_id=$1 LIMIT 1', [r.file_id])).rowCount
      )
        throw new FileFault('UPLOAD_STATE_CHANGED', 409);
      await lockFileCapacity(c);
      await c.query(
        "UPDATE files SET state='deleted',storage_deleted_at=clock_timestamp() WHERE id=$1",
        [r.file_id],
      );
      await c.query(
        'UPDATE file_upload_intents SET closed_at=coalesce(closed_at,clock_timestamp()),last_error=NULL WHERE file_id=$1',
        [r.file_id],
      );
      await c.query('UPDATE file_object_copies SET deleted_at=clock_timestamp() WHERE file_id=$1', [
        r.file_id,
      ]);
      await c.query(
        'UPDATE file_workspace_usage SET reserved_bytes=reserved_bytes-$2,files_count=files_count-1 WHERE workspace_id=$1',
        [r.workspace_id, Number(r.reserved_bytes)],
      );
    });
  }
  private async cleanStaging(s: S3ObjectStorage, r: Row, epoch: string) {
    // The final key is immutable and excluded even if a validation job runs concurrently.
    const until = (
      await this.pool.query<{ until: Date | null }>(
        "SELECT max(expires_at)+interval '120 seconds' AS until FROM file_part_leases WHERE file_id=$1",
        [r.file_id],
      )
    ).rows[0]!.until;
    if (until && until.getTime() > Date.now()) {
      await this.pool.query(
        'UPDATE file_upload_intents SET next_attempt_at=$2 WHERE file_id=$1 AND job_epoch=$3',
        [r.file_id, until, epoch],
      );
      return;
    }
    if (!r.final_key || !r.bytes_verified_at) throw new Error('FINAL_OBJECT_NOT_VERIFIED');
    if (r.staging_key)
      for (const upload of await s.uploads(r.staging_key)) await s.abort(r.staging_key, upload);
    const obsolete = (
      await this.pool.query<{ object_key: string }>(
        'SELECT object_key FROM file_object_copies WHERE file_id=$1 AND object_key<>$2 AND NOT retained AND deleted_at IS NULL',
        [r.file_id, r.final_key],
      )
    ).rows.map((x) => x.object_key);
    for (const key of new Set(
      [r.staging_key, ...obsolete].filter((k): k is string => !!k && k !== r.final_key),
    )) {
      await s.delete(key);
      if (await s.head(key)) throw new Error('STORAGE_DELETE_UNCONFIRMED');
    }
    await this.boundary.transaction(async (c) => {
      await c.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [r.file_id]);
      const current = await this.row(r.file_id, c);
      if (
        current.job_epoch !== epoch ||
        !['validating', 'ready'].includes(current.state) ||
        current.final_key !== r.final_key
      )
        throw new FileFault('UPLOAD_STATE_CHANGED', 409);
      await c.query(
        'UPDATE file_object_copies SET deleted_at=clock_timestamp() WHERE file_id=$1 AND object_key<>$2 AND NOT retained',
        [r.file_id, r.final_key],
      );
      await c.query(
        'UPDATE file_upload_intents SET staging_cleaned_at=clock_timestamp(),last_error=NULL WHERE file_id=$1',
        [r.file_id],
      );
    });
  }
  private async orphans() {
    const days = Number(process.env.TRASH_RETENTION_DAYS ?? 30),
      hours = Number(process.env.ORPHAN_FILE_RETENTION_HOURS ?? 24);
    if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(hours) || hours < 1)
      throw new Error('Invalid file retention');
    const predicate = `f.state='ready' AND NOT EXISTS(SELECT 1 FROM file_usages u WHERE u.file_id=f.id) AND
      ((f.ever_attached AND f.orphaned_at<clock_timestamp()-$1*interval '1 day') OR
      (NOT f.ever_attached AND coalesce(i.attach_until,i.created_at+$2*interval '1 hour')<clock_timestamp()))`;
    const ids = (
      await this.pool.query<{ id: string }>(
        `SELECT f.id FROM files f JOIN file_upload_intents i ON i.file_id=f.id WHERE ${predicate} LIMIT 20`,
        [days, hours],
      )
    ).rows;
    for (const { id } of ids)
      await this.boundary.transaction(async (c) => {
        await c.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [id]);
        // Re-evaluate after the common file latch; a concurrently attached reference wins safely.
        const marked = await c.query(
          `UPDATE files f SET state='deleting' FROM file_upload_intents i WHERE i.file_id=f.id AND f.id=$3 AND ${predicate} RETURNING f.id`,
          [days, hours, id],
        );
        if (marked.rowCount)
          await c.query(
            'UPDATE file_upload_intents SET next_attempt_at=clock_timestamp() WHERE file_id=$1',
            [id],
          );
      });
  }
}
