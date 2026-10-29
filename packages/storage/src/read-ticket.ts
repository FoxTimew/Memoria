import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { FileReadClaim } from '@memoria/db';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = [
  'user',
  'session',
  'workspace',
  'page',
  'file',
  'usage',
  'generation',
  'accessVersion',
  'database',
  'lifecycle',
  'fileVersion',
  'variant',
  'expires',
];
/** Encrypted bearer capability: even the session identifier is not exposed in the URL.
 * Possession never replaces the gateway's live access check. No caller supplies object keys. */
export class ReadTickets {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32) throw Error('Invalid file ticket secret');
    this.key = createHmac('sha256', secret).update('memoria:file-read:v1').digest();
  }
  issue(claim: FileReadClaim, now = Date.now()) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('memoria:file-read:v1'));
    const data = Buffer.concat([
      cipher.update(JSON.stringify({ ...claim, expires: now + 60000 })),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }
  open(token: string, now = Date.now()): FileReadClaim {
    try {
      if (!/^[A-Za-z0-9_-]{100,1600}$/.test(token)) throw Error();
      const bytes = Buffer.from(token, 'base64url');
      if (bytes.toString('base64url') !== token) throw Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decipher.setAAD(Buffer.from('memoria:file-read:v1'));
      const claim = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      );
      if (
        !claim ||
        Object.keys(claim).length !== keys.length ||
        Object.keys(claim).some((k) => !keys.includes(k))
      )
        throw Error();
      for (const k of ['workspace', 'page', 'file', 'usage'])
        if (typeof claim[k] !== 'string' || !uuid.test(claim[k])) throw Error();
      for (const k of ['user', 'session'])
        if (typeof claim[k] !== 'string' || claim[k].length < 1 || claim[k].length > 128)
          throw Error();
      for (const k of ['generation', 'database'])
        if (claim[k] !== null && (typeof claim[k] !== 'string' || !uuid.test(claim[k])))
          throw Error();
      if (
        claim.lifecycle !== null &&
        (typeof claim.lifecycle !== 'string' || !/^\d{1,20}$/.test(claim.lifecycle))
      )
        throw Error();
      if (
        !['original', 'display', 'thumbnail'].includes(claim.variant) ||
        !Number.isSafeInteger(claim.accessVersion) ||
        claim.accessVersion < 1 ||
        !Number.isSafeInteger(claim.fileVersion) ||
        claim.fileVersion < 1
      )
        throw Error();
      if (
        !Number.isSafeInteger(claim.expires) ||
        claim.expires <= now ||
        claim.expires > now + 60000
      )
        throw Error();
      delete claim.expires;
      return claim;
    } catch {
      throw Error('INVALID_FILE_TICKET');
    }
  }
}
