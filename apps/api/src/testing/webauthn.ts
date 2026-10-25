import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// Test authenticator: real P-256 signatures and a minimal "none" attestation.
// This encodes WebAuthn wire data; the production verifier is never mocked.
function cbor(value: number | string | Buffer | Map<number | string, unknown>): Buffer {
  const header = (major: number, length: number) =>
    length < 24
      ? Buffer.from([major * 32 + length])
      : length < 256
        ? Buffer.from([major * 32 + 24, length])
        : Buffer.from([major * 32 + 25, length >> 8, length & 255]);
  if (typeof value === 'number') return header(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([header(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([header(2, value.length), value]);
  return Buffer.concat([
    header(5, value.size),
    ...[...value].flatMap(([key, entry]) => [cbor(key), cbor(entry as Parameters<typeof cbor>[0])]),
  ]);
}
export function testAuthenticator() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    id = randomBytes(32);
  const publicKey = keys.publicKey.export({ format: 'jwk' });
  const cose = cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(publicKey.x!, 'base64url')],
      [-3, Buffer.from(publicKey.y!, 'base64url')],
    ]),
  );
  let counter = 0;
  function data(
    challenge: string,
    type: string,
    origin: string,
    uv: boolean,
    registration: boolean,
    rpId: string,
  ) {
    const client = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter++);
    const auth = Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([1 + (uv ? 4 : 0) + (registration ? 64 : 0)]),
      count,
    ]);
    return { client, auth };
  }
  return {
    id: id.toString('base64url'),
    register(challenge: string, uv = true, origin = 'https://localhost', rpId = 'localhost') {
      const { client, auth } = data(challenge, 'webauthn.create', origin, uv, true, rpId);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const attestation = cbor(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', Buffer.concat([auth, Buffer.alloc(16), length, id, cose])],
        ]),
      );
      return {
        id: id.toString('base64url'),
        rawId: id.toString('base64url'),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString('base64url'),
          attestationObject: attestation.toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    authenticate(challenge: string, uv = true, origin = 'https://localhost', rpId = 'localhost') {
      const { client, auth } = data(challenge, 'webauthn.get', origin, uv, false, rpId);
      const signature = sign(
        'sha256',
        Buffer.concat([auth, createHash('sha256').update(client).digest()]),
        keys.privateKey,
      );
      return {
        id: id.toString('base64url'),
        rawId: id.toString('base64url'),
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString('base64url'),
          authenticatorData: auth.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      };
    },
  };
}
