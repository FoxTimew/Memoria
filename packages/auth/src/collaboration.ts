import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
export function internalSignature(
  secret: string,
  path: string,
  body: string,
  timestamp = String(Date.now()),
  nonce: string = randomUUID(),
) {
  if (secret.length < 32) throw new Error('COLLAB_INTERNAL_SECRET_REQUIRED');
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`POST\n${path}\n${timestamp}\n${nonce}\n${digest}`)
    .digest('hex');
  return {
    'x-memoria-time': timestamp,
    'x-memoria-nonce': nonce,
    'x-memoria-signature': signature,
  };
}
export function verifyInternalSignature(
  secret: string,
  path: string,
  body: string,
  headers: Record<string, string | undefined>,
  now = Date.now(),
) {
  const timestamp = headers['x-memoria-time'] ?? '',
    nonce = headers['x-memoria-nonce'] ?? '',
    signature = headers['x-memoria-signature'] ?? '';
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 30000 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    throw new Error('INTERNAL_AUTH_DENIED');
  const expected = internalSignature(secret, path, body, timestamp, nonce)['x-memoria-signature'];
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')))
    throw new Error('INTERNAL_AUTH_DENIED');
  return nonce;
}
