import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import type { Pool } from 'pg';
import type { S3ObjectStorage } from './index.ts';
type Entry = {
  key: string;
  bytes: number;
  sha256: string;
  nonce: string;
  tag: string;
  archive: string;
};
/** Operator primitive for a FROZEN, completed dataset. No route calls this code.
 * Caller must stop admissions/GC/publications and encrypt its matching pg_dump too. */
export async function exportFiles(
  pool: Pool,
  storage: S3ObjectStorage,
  directory: string,
  key: Buffer,
) {
  if (key.length !== 32) throw Error('INVALID_BACKUP_KEY');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (
    (await pool.query("SELECT 1 FROM files WHERE state NOT IN ('ready','deleted') LIMIT 1"))
      .rowCount
  )
    throw Error('BACKUP_REQUIRES_COMPLETED_DATASET');
  const rows = (
    await pool.query<{ object_key: string; bytes: string; sha256: string }>(
      `SELECT object_key,byte_size::text bytes,sha256 FROM files WHERE state='ready' UNION ALL SELECT v.object_key,v.byte_size::text,v.sha256 FROM file_variants v JOIN files f ON f.id=v.file_id WHERE f.state='ready' ORDER BY object_key`,
    )
  ).rows;
  const entries: Entry[] = [];
  for (const r of rows) {
    if (!/^objects\/[a-zA-Z0-9/-]{1,200}$/.test(r.object_key) || !/^[a-f0-9]{64}$/.test(r.sha256))
      throw Error('BACKUP_UNVERIFIED_OBJECT');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce),
      hash = createHash('sha256');
    let bytes = 0;
    const archive = String(entries.length) + '.bin';
    cipher.setAAD(Buffer.from(r.object_key));
    await pipeline(
      await storage.read(r.object_key),
      new Transform({
        transform(chunk, _, done) {
          bytes += chunk.length;
          hash.update(chunk);
          if (bytes > Number(r.bytes)) done(Error('BACKUP_SIZE_MISMATCH'));
          else done(null, chunk);
        },
      }),
      cipher,
      createWriteStream(resolve(directory, archive), { flags: 'wx', mode: 0o600 }),
    );
    if (bytes !== Number(r.bytes) || hash.digest('hex') !== r.sha256)
      throw Error('BACKUP_HASH_MISMATCH');
    entries.push({
      key: r.object_key,
      bytes,
      sha256: r.sha256,
      nonce: nonce.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      archive,
    });
  }
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('memoria-backup-manifest-v1'));
  await writeFile(
    resolve(directory, 'manifest.bin'),
    Buffer.concat([
      nonce,
      cipher.update(JSON.stringify(entries)),
      cipher.final(),
      cipher.getAuthTag(),
    ]),
    { flag: 'wx', mode: 0o600 },
  );
  return { objects: entries.length, bytes: entries.reduce((n, r) => n + r.bytes, 0) };
}
async function manifest(directory: string, key: Buffer): Promise<Entry[]> {
  const path = resolve(directory, 'manifest.bin');
  if ((await lstat(path)).size > 16 * 1024 ** 2) throw Error('BACKUP_MANIFEST_LIMIT');
  const b = await readFile(path),
    d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(Buffer.from('memoria-backup-manifest-v1'));
  d.setAuthTag(b.subarray(-16));
  const entries = JSON.parse(
    Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString('utf8'),
  ) as Entry[];
  if (!Array.isArray(entries) || entries.length > 200000) throw Error('INVALID_BACKUP_MANIFEST');
  for (const e of entries)
    if (
      !/^objects\/[a-zA-Z0-9/-]{1,200}$/.test(e.key) ||
      !/^\d{1,6}\.bin$/.test(e.archive) ||
      !Number.isSafeInteger(e.bytes) ||
      e.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(e.sha256) ||
      !/^[a-f0-9]{24}$/.test(e.nonce) ||
      !/^[a-f0-9]{32}$/.test(e.tag)
    )
      throw Error('INVALID_BACKUP_MANIFEST');
  return entries;
}
function decrypt(directory: string, key: Buffer, e: Entry) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.nonce, 'hex'));
  d.setAAD(Buffer.from(e.key));
  d.setAuthTag(Buffer.from(e.tag, 'hex'));
  const input = createReadStream(resolve(directory, e.archive));
  input.on('error', (err) => d.destroy(err));
  d.on('close', () => input.destroy());
  return input.pipe(d);
}
export async function verifyFilesBackup(directory: string, key: Buffer) {
  const entries = await manifest(directory, key);
  for (const e of entries) {
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(
      decrypt(directory, key, e),
      new Writable({
        write(chunk, _, done) {
          bytes += chunk.length;
          hash.update(chunk);
          done(bytes > e.bytes ? Error('BACKUP_SIZE_MISMATCH') : undefined);
        },
      }),
    );
    if (bytes !== e.bytes || hash.digest('hex') !== e.sha256) throw Error('BACKUP_HASH_MISMATCH');
  }
  return entries;
}
/** Target must be offline and empty. Verification of every encrypted object precedes any write. */
export async function restoreFiles(storage: S3ObjectStorage, directory: string, key: Buffer) {
  const entries = await verifyFilesBackup(directory, key);
  for (const e of entries) if (await storage.head(e.key)) throw Error('RESTORE_TARGET_NOT_EMPTY');
  for (const e of entries)
    await storage.restoreObject(
      e.key,
      decrypt(directory, key, e),
      e.bytes,
      Buffer.from(e.sha256, 'hex').toString('base64'),
    );
  for (const e of entries) {
    let bytes = 0;
    const h = createHash('sha256');
    for await (const chunk of await storage.read(e.key)) {
      bytes += chunk.length;
      h.update(chunk);
    }
    if (bytes !== e.bytes || h.digest('hex') !== e.sha256) throw Error('RESTORE_HASH_MISMATCH');
  }
  return { objects: entries.length, bytes: entries.reduce((n, e) => n + e.bytes, 0) };
}
