import { createReadStream } from 'node:fs';
import { mkdir, readFile, lstat, unlink, rmdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileFault, resolvePageAccess, admitFileCapacity, lockFileCapacity } from '@memoria/db';
import { UploadService } from './uploads.ts';
import {
  cleanupExchange,
  createExchangeJob,
  convertExchange,
  writeSource,
  removeJob,
  removePrivate,
  type ExchangeJob,
  type ValidatorConfig,
} from './exchange.ts';
export { validatorConfig, type ValidatorConfig } from './exchange.ts';
const marker = 'memoria-file-validation-v1';
export async function cleanupValidationDirectory(root: string, now = Date.now()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^job-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
    const path = resolve(root, entry.name);
    if ((await lstat(path)).mtimeMs > now - 3600000) continue;
    try {
      if ((await readFile(resolve(path, 'owner'), 'utf8')) !== marker) continue;
      if ((await readdir(path)).some((n) => !['owner', 'input', 'output'].includes(n))) continue;
      const files: string[] = [];
      for (const [dir, names] of [
        ['input', ['source']],
        ['output', ['display.webp', 'thumbnail.webp', 'result.json']],
      ] as const) {
        const folder = resolve(path, dir),
          st = await lstat(folder);
        if (!st.isDirectory() || st.isSymbolicLink()) throw Error('UNEXPECTED_SCRATCH_ENTRY');
        for (const name of await readdir(folder)) {
          if (
            !(names as readonly string[]).includes(name) ||
            (await lstat(resolve(folder, name))).isSymbolicLink()
          )
            throw Error('UNEXPECTED_SCRATCH_ENTRY');
          files.push(resolve(folder, name));
        }
      }
      for (const file of files) await unlink(file);
      await rmdir(resolve(path, 'input'));
      await rmdir(resolve(path, 'output'));
      await unlink(resolve(path, 'owner'));
      await rmdir(path);
      count++;
    } catch {
      /* Unknown content is never recursively removed. Operator can inspect it. */
    }
  }
  return count;
}
/** Only this worker owns the private publication copy. The exchange is polled; no Docker client. */
export class FileValidator {
  constructor(
    readonly uploads: UploadService,
    readonly config: ValidatorConfig,
  ) {}
  async tick() {
    const c = await this.uploads.pool.connect();
    let acquired = false,
      lost = false;
    const fail = () => {
      lost = true;
    };
    c.on('error', fail);
    let pulse: ReturnType<typeof setInterval> | undefined;
    try {
      acquired = (
        await c.query("SELECT pg_try_advisory_lock(hashtextextended('file-image-worker',0)) ok")
      ).rows[0].ok;
      if (!acquired) return false;
      await cleanupExchange(this.config.directory);
      pulse = setInterval(() => {
        void c.query('SELECT 1').catch(fail);
      }, 1000);
      const id = (
        await this.uploads.pool.query(
          "SELECT f.id FROM files f JOIN file_upload_intents i ON i.file_id=f.id WHERE f.state='validating' AND i.validation_attempt_at<=clock_timestamp() ORDER BY f.created_at LIMIT 1",
        )
      ).rows[0]?.id;
      if (!id) return false;
      await this.validate(id, () => {
        if (lost) throw Error('VALIDATOR_LEASE_LOST');
      });
      return true;
    } finally {
      if (pulse) clearInterval(pulse);
      c.off('error', fail);
      if (acquired && !lost)
        await c
          .query("SELECT pg_advisory_unlock(hashtextextended('file-image-worker',0))")
          .catch(() => {
            lost = true;
          });
      c.release(lost);
    }
  }
  private async validate(id: string, assertLease: () => void) {
    let job: ExchangeJob | undefined,
      privatePath: string | undefined,
      claimedEpoch: string | undefined;
    try {
      await this.uploads.objectLock(id, async (s, epoch, assertJob) => {
        claimedEpoch = epoch;
        const r = (
          await this.uploads.pool.query(
            `SELECT i.*,f.state,f.object_key,r.database_id FROM file_upload_intents i JOIN files f ON f.id=i.file_id LEFT JOIN database_rows r ON r.page_id=i.page_id WHERE i.file_id=$1`,
            [id],
          )
        ).rows[0];
        if (!r || r.state !== 'validating' || !r.bytes_verified_at) return;
        const a = {
          key: id,
          user: r.user_id,
          session: r.session_id,
          workspace: r.workspace_id,
          page: r.page_id,
          ...(r.database_id ? { rowScope: { database: r.database_id } } : {}),
        };
        job = await createExchangeJob(this.config, Number(r.requested_bytes));
        const check = () => {
          assertLease();
          assertJob();
        };
        await writeSource(
          job,
          await s.read(r.object_key),
          Number(r.requested_bytes),
          r.whole_checksum,
          check,
        );
        const converted = await convertExchange(job, this.config, Number(r.requested_bytes), check);
        privatePath = converted.privatePath;
        const result = converted.result;
        if (result.variants.reduce((n, v) => n + v.bytes, 0) > this.uploads.limits.derivativeBytes)
          throw Error('INVALID_DERIVATIVE_BUDGET');
        const variants = result.variants.map((v) => ({
          ...v,
          key: 'objects/' + r.workspace_id + '/' + id + '/' + randomUUID(),
        }));
        assertLease();
        await this.uploads.boundary.transaction(async (tx) => {
          await this.uploads.boundary.lock(tx, a.workspace, {
            destination: a.page,
            pages: [a.page],
            files: [id],
            sources: [],
          });
          assertJob();
          if (
            !(
              await tx.query(
                "SELECT 1 FROM files f JOIN file_upload_intents i ON i.file_id=f.id WHERE f.id=$1 AND f.state='validating' AND i.job_epoch=$2 FOR UPDATE OF i",
                [id, epoch],
              )
            ).rowCount
          )
            throw Error('STALE_VALIDATOR');
          await admitFileCapacity(tx, this.uploads.limits, {
            reserved: 0,
            staging: 0,
            copies: variants.reduce((n, v) => n + v.bytes, 0),
          });
          for (const v of variants)
            await tx.query(
              'INSERT INTO file_object_copies(object_key,file_id,epoch,byte_size) VALUES($1,$2,$3,$4)',
              [v.key, id, epoch, v.bytes],
            );
        });
        for (const v of variants) {
          assertLease();
          await s.putDerivative(
            v.key,
            createReadStream(resolve(privatePath!, v.variant + '.webp')),
            v.bytes,
            Buffer.from(v.sha256, 'hex').toString('base64'),
          );
        }
        await this.uploads.boundary.transaction(async (tx) => {
          await this.uploads.boundary.lock(tx, a.workspace, {
            destination: a.page,
            pages: [a.page],
            files: [id],
            sources: [],
          });
          assertLease();
          assertJob();
          if (
            !(
              await tx.query(
                "SELECT 1 FROM files f JOIN file_upload_intents i ON i.file_id=f.id WHERE f.id=$1 AND f.state='validating' AND i.job_epoch=$2 FOR UPDATE OF i",
                [id, epoch],
              )
            ).rowCount
          )
            throw Error('STALE_VALIDATOR');
          if ((await resolvePageAccess(tx, [a])).get(id)?.level !== 'edit')
            throw new FileFault('FILE_UNAVAILABLE');
          if (result.status === 'rejected') {
            await tx.query(
              "UPDATE files SET state='rejected',preview_status='rejected' WHERE id=$1",
              [id],
            );
            await tx.query(
              "UPDATE file_upload_intents SET closed_at=clock_timestamp(),last_error='FILE_FORMAT_REJECTED',expires_at=clock_timestamp()+interval '24 hours' WHERE file_id=$1 AND job_epoch=$2",
              [id, epoch],
            );
            return;
          }
          await lockFileCapacity(tx);
          for (const v of variants) {
            await tx.query(
              'INSERT INTO file_variants(file_id,variant,object_key,byte_size,width,height,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',
              [id, v.variant, v.key, v.bytes, v.width, v.height, v.sha256],
            );
            await tx.query('UPDATE file_object_copies SET retained=true WHERE object_key=$1', [
              v.key,
            ]);
          }
          const reserved = Number(r.requested_bytes) + variants.reduce((n, v) => n + v.bytes, 0);
          await tx.query(
            'UPDATE file_workspace_usage SET reserved_bytes=reserved_bytes-$2 WHERE workspace_id=$1',
            [r.workspace_id, Number(r.reserved_bytes) - reserved],
          );
          await tx.query(
            "UPDATE file_upload_intents SET closed_at=clock_timestamp(),reserved_bytes=$2,last_error=NULL,next_attempt_at=clock_timestamp(),attach_until=clock_timestamp()+interval '24 hours' WHERE file_id=$1",
            [id, reserved],
          );
          await tx.query(
            "UPDATE files SET state='ready',mime_type=$2,preview_status=$3,pixel_width=$4,pixel_height=$5,updated_at=clock_timestamp() WHERE id=$1",
            [id, result.mime, result.preview, result.width ?? null, result.height ?? null],
          );
        });
      });
    } catch (e) {
      // No decoder/SDK error details, filenames or object keys escape into telemetry.
      if (claimedEpoch)
        await this.uploads.pool.query(
          "UPDATE file_upload_intents i SET validation_attempt_at=clock_timestamp()+interval '30 seconds',last_error='FILE_VALIDATION_RETRY' FROM files f WHERE f.id=i.file_id AND f.state='validating' AND i.file_id=$1 AND i.job_epoch=$2",
          [id, claimedEpoch],
        );
      throw e;
    } finally {
      if (privatePath) await removePrivate(privatePath);
      if (job) {
        // Finished jobs can be removed. A decoder still running owns its directory until expiry.
        const finished = await lstat(resolve(job.path, 'result.json')).catch(() => null);
        const submitted =
          (await lstat(resolve(job.path, 'request.json')).catch(() => null)) ??
          (await lstat(resolve(job.path, 'running.json')).catch(() => null));
        if (finished || !submitted) await removeJob(job.path).catch(() => {});
      }
    }
  }
}
