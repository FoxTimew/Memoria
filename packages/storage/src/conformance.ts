import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListPartsCommand,
  PutBucketCorsCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3ObjectStorage } from './index.ts';

const provider = process.env.STORAGE_TEST_PROVIDER!;
const endpoint = process.env.STORAGE_TEST_ENDPOINT!;
// Explicit loopback fixture only. Never accept a production endpoint in this destructive suite.
if (
  !['http://127.0.0.1:9000', 'http://127.0.0.1:18333', 'http://127.0.0.1:19000'].includes(endpoint)
)
  throw new Error('LOCAL_STORAGE_FIXTURE_REQUIRED');
const bucket = `memoria-proof-files-${randomUUID()}`;
const storage = new S3ObjectStorage({
  endpoint,
  bucket,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.STORAGE_TEST_ACCESS!,
    secretAccessKey: process.env.STORAGE_TEST_SECRET!,
  },
});
const scenarios: { name: string; passed: boolean; error?: string }[] = [];
const observations: { stage: string; value: unknown }[] = [];
function observe(stage: string, value: unknown) {
  observations.push({ stage, value });
  console.log(`OBSERVE ${stage}: ${JSON.stringify(value)}`);
}
const uploads = new Map<string, string>();
const keys = new Set<string>();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');
async function scenario(name: string, run: () => Promise<void>) {
  try {
    await run();
    scenarios.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    // Do not print SDK errors, response bodies, credentials, signed URLs or arbitrary stacks.
    const nameOnly = (error as { name?: string }).name ?? 'Error';
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    scenarios.push({ name, passed: false, error: `${nameOnly}${status ? ` HTTP ${status}` : ''}` });
    console.log(`FAIL ${name}: ${nameOnly}${status ? ` HTTP ${status}` : ''}`);
  }
}
async function sendPart(url: string, headers: Record<string, string>, body: Uint8Array) {
  const r = await fetch(url, {
    method: 'PUT',
    headers,
    body: Buffer.from(body),
    redirect: 'error',
  });
  const status = r.status;
  await r.body?.cancel();
  return status;
}
async function chunked(url: string, headers: Record<string, string>, body: Uint8Array) {
  return new Promise<number>((resolve, reject) => {
    const req = request(url, { method: 'PUT', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.setTimeout(10000, () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject);
    req.write(body.subarray(0, 128));
    req.end(body.subarray(128));
  });
}
async function post(
  form: Awaited<ReturnType<S3ObjectStorage['createUpload']>>,
  bytes: number,
  fill = 0,
) {
  const data = new FormData();
  for (const [key, value] of Object.entries(form.fields)) data.set(key, value);
  data.set(
    'file',
    new Blob([new Uint8Array(bytes).fill(fill)], { type: 'application/octet-stream' }),
    'asset.bin',
  );
  const r = await fetch(form.url, { method: 'POST', body: data, redirect: 'error' });
  await r.body?.cancel();
  return r.status;
}
async function hashRead(key: string, range?: { start: number; end: number }) {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of await storage.read(key, range)) {
    h.update(chunk);
    bytes += chunk.length;
  }
  return { hash: h.digest('base64'), bytes };
}

// Completion uses the checksums from the immutable signed plan, not an optional
// ListParts checksum field. ListParts is evidence to reconcile against that plan.
function plannedParts(
  parts: Awaited<ReturnType<S3ObjectStorage['parts']>>,
  first: Uint8Array,
  last: Uint8Array,
) {
  assert.deepEqual(
    parts.map((p) => [p.number, p.bytes]),
    [
      [1, first.length],
      [2, last.length],
    ],
  );
  return parts.map((part) => {
    const checksum = sha(part.number === 1 ? first : last);
    if (part.checksum) assert.equal(part.checksum, checksum);
    return { ...part, checksum };
  });
}

let created = false;
try {
  await storage.client.send(new CreateBucketCommand({ Bucket: bucket }));
  created = true;
  const origin = 'https://localhost';
  await scenario('CORS exact origin configured and preflight returned', async () => {
    if (process.env.STORAGE_TEST_CORS !== 'global')
      await storage.client.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [origin],
                AllowedMethods: ['POST', 'PUT'],
                AllowedHeaders: ['content-type', 'x-amz-checksum-sha256'],
                ExposeHeaders: ['ETag'],
              },
            ],
          },
        }),
      );
    const r = await fetch(`${endpoint}/${bucket}/staging/preflight`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'x-amz-checksum-sha256',
      },
    });
    observe('CORS allowed preflight', {
      status: r.status,
      origin: r.headers.get('access-control-allow-origin'),
    });
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
    await r.body?.cancel();
    const foreign = await fetch(`${endpoint}/${bucket}/staging/preflight`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.invalid',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'x-amz-checksum-sha256',
      },
    });
    observe('CORS foreign preflight', {
      status: foreign.status,
      origin: foreign.headers.get('access-control-allow-origin'),
    });
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    await foreign.body?.cancel();
  });
  const key = `staging/${randomUUID()}`;
  keys.add(key);
  const form = await storage.createUpload(key, 1024);
  await scenario('POST accepts exact reserved size', async () => {
    assert.ok((await post(form, 1024)) < 300);
    assert.equal((await storage.head(key))?.bytes, 1024);
  });
  await scenario('POST rejects oversized object', async () => {
    assert.ok((await post(form, 1025)) >= 400);
    assert.equal((await storage.head(key))?.bytes, 1024);
  });
  await scenario('POST rejects undersized object', async () => {
    assert.ok((await post(form, 1023)) >= 400);
  });
  const finalKey = `objects/${randomUUID()}`;
  keys.add(finalKey);
  await scenario('immutable copy survives staging replay', async () => {
    await storage.copy(key, finalKey);
    const before = await hashRead(finalKey);
    assert.ok((await post(form, 1024, 59)) < 300);
    assert.deepEqual(await hashRead(finalKey), before);
    assert.notEqual((await hashRead(key)).hash, before.hash);
    await assert.rejects(storage.createUpload(finalKey, 1024), /IMMUTABLE_OBJECT/);
  });
  await scenario('private object rejects anonymous read', async () => {
    const r = await fetch(`${endpoint}/${bucket}/${finalKey}`);
    assert.ok(r.status === 403 || r.status === 404);
    await r.body?.cancel();
  });
  await scenario('Range reads exact requested bytes in a stream', async () => {
    assert.equal((await hashRead(finalKey, { start: 10, end: 109 })).bytes, 100);
  });

  const partKey = `staging/${randomUUID()}`;
  keys.add(partKey);
  const upload = await storage.initiate(partKey);
  uploads.set(partKey, upload);
  const first = new Uint8Array(16 * 1024 ** 2).fill(37);
  const last = new Uint8Array(5 * 1024 ** 2).fill(43);
  const signed = await storage.signPart(partKey, upload, 1, first.length, sha(first));
  await scenario('UploadPart capability signs length checksum and part number', async () => {
    const url = new URL(signed.url);
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')!;
    assert.ok(signedHeaders.includes('content-length'));
    assert.ok(signedHeaders.includes('x-amz-checksum-sha256'));
    assert.equal(url.searchParams.get('partNumber'), '1');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '120');
  });
  await scenario('UploadPart valid 16 MiB', async () => {
    assert.equal(await sendPart(signed.url, signed.headers, first), 200);
  });
  await scenario('UploadPart rejects tampered bytes with unchanged checksum', async () => {
    const wrong = first.slice();
    wrong[0] = 77;
    assert.ok((await sendPart(signed.url, signed.headers, wrong)) >= 400);
  });
  await scenario('UploadPart rejects excess length', async () => {
    assert.ok(
      (await sendPart(signed.url, signed.headers, new Uint8Array(first.length + 1))) >= 400,
    );
  });
  await scenario('UploadPart rejects chunked unsigned length', async () => {
    assert.ok((await chunked(signed.url, signed.headers, first)) >= 400);
  });
  await scenario('UploadPart rejects substituted part number', async () => {
    const url = new URL(signed.url);
    url.searchParams.set('partNumber', '3');
    assert.ok((await sendPart(url.toString(), signed.headers, first)) >= 400);
  });
  await scenario('multipart list resume and complete from server list', async () => {
    // Replay the known valid part after hostile attempts; successful attack above still fails the gate.
    const replayStatus = await sendPart(signed.url, signed.headers, first);
    observe('resume valid first part status', replayStatus);
    assert.equal(replayStatus, 200);
    const second = await storage.signPart(partKey, upload, 2, last.length, sha(last));
    const secondStatus = await sendPart(second.url, second.headers, last);
    observe('last part status', secondStatus);
    assert.equal(secondStatus, 200);
    const parts = await storage.parts(partKey, upload);
    observe(
      'server part numbers and sizes',
      parts.map((p) => [p.number, p.bytes]),
    );
    assert.deepEqual(
      parts.map((p) => [p.number, p.bytes]),
      [
        [1, first.length],
        [2, last.length],
      ],
    );
    await storage.complete(partKey, upload, plannedParts(parts, first, last));
    uploads.delete(partKey);
    const expected = createHash('sha256').update(first).update(last).digest('base64');
    const actual = await hashRead(partKey);
    observe('completed size and hash equality', {
      bytes: actual.bytes,
      expectedBytes: first.length + last.length,
      hashMatches: actual.hash === expected,
    });
    assert.deepEqual(actual, { bytes: first.length + last.length, hash: expected });
  });
  await scenario('abort prevents replay and leaves no ready object', async () => {
    const abandoned = `staging/${randomUUID()}`;
    const id = await storage.initiate(abandoned);
    uploads.set(abandoned, id);
    const part = await storage.signPart(abandoned, id, 1, first.length, sha(first));
    await storage.abort(abandoned, id);
    uploads.delete(abandoned);
    const replayStatus = await sendPart(part.url, part.headers, first).catch(async (error) => {
      observe('aborted replay transport error', {
        name: error.name,
        code: error.cause?.code,
        objectExists: !!(await storage.head(abandoned)),
        listAvailable: await storage.parts(abandoned, id).then(
          () => true,
          () => false,
        ),
      });
      throw error;
    });
    observe('aborted replay status', replayStatus);
    assert.ok(replayStatus >= 400);
    assert.equal(await storage.head(abandoned), null);
  });
  for (const replay of [false, true]) {
    await scenario(`isolated multipart without hostile requests; retry=${replay}`, async () => {
      const cleanKey = `staging/${randomUUID()}`;
      keys.add(cleanKey);
      const id = await storage.initiate(cleanKey);
      uploads.set(cleanKey, id);
      const one = await storage.signPart(cleanKey, id, 1, first.length, sha(first));
      assert.equal(await sendPart(one.url, one.headers, first), 200);
      if (replay) assert.equal(await sendPart(one.url, one.headers, first), 200);
      const two = await storage.signPart(cleanKey, id, 2, last.length, sha(last));
      assert.equal(await sendPart(two.url, two.headers, last), 200);
      const parts = await storage.parts(cleanKey, id);
      observe(
        `clean parts retry=${replay}`,
        parts.map((p) => [p.number, p.bytes]),
      );
      // One raw SDK call excludes any bug in our pagination/aggregation helper.
      const raw = await storage.client.send(
        new ListPartsCommand({ Bucket: bucket, Key: cleanKey, UploadId: id, MaxParts: 1000 }),
      );
      observe(`single ListParts response retry=${replay}`, {
        isTruncated: raw.IsTruncated ?? false,
        parts: raw.Parts?.map((p) => ({
          number: p.PartNumber,
          bytes: p.Size,
          hasChecksum: Boolean(p.ChecksumSHA256),
        })),
      });
      assert.deepEqual(
        parts.map((p) => [p.number, p.bytes]),
        [
          [1, first.length],
          [2, last.length],
        ],
      );
      await storage.complete(cleanKey, id, plannedParts(parts, first, last));
      uploads.delete(cleanKey);
      const actual = await hashRead(cleanKey);
      const expected = createHash('sha256').update(first).update(last).digest('base64');
      observe(`clean result retry=${replay}`, {
        bytes: actual.bytes,
        hashMatches: actual.hash === expected,
      });
      assert.deepEqual(actual, { bytes: first.length + last.length, hash: expected });
    });
  }
  await scenario('replacement hides old part and rejects superseded ETag', async () => {
    const key = `staging/${randomUUID()}`;
    keys.add(key);
    const id = await storage.initiate(key);
    uploads.set(key, id);
    const old = await storage.signPart(key, id, 1, first.length, sha(first));
    assert.equal(await sendPart(old.url, old.headers, first), 200);
    const oldParts = await storage.parts(key, id);
    const replacement = new Uint8Array(first.length).fill(91);
    const updated = await storage.signPart(key, id, 1, replacement.length, sha(replacement));
    assert.equal(await sendPart(updated.url, updated.headers, replacement), 200);
    const end = await storage.signPart(key, id, 2, last.length, sha(last));
    assert.equal(await sendPart(end.url, end.headers, last), 200);
    const current = plannedParts(await storage.parts(key, id), replacement, last);
    assert.notEqual(current[0]!.etag, oldParts[0]!.etag);
    const stale = [{ ...oldParts[0]!, checksum: sha(first) }, current[1]!];
    await assert.rejects(storage.complete(key, id, stale));
    assert.equal(await storage.head(key), null);
    await storage.complete(key, id, current);
    uploads.delete(key);
    const expected = createHash('sha256').update(replacement).update(last).digest('base64');
    assert.deepEqual(await hashRead(key), {
      bytes: replacement.length + last.length,
      hash: expected,
    });
  });
  await scenario('concurrent retries preserve one part and correct final bytes', async () => {
    const key = `staging/${randomUUID()}`;
    keys.add(key);
    const id = await storage.initiate(key);
    uploads.set(key, id);
    const one = await storage.signPart(key, id, 1, first.length, sha(first));
    const two = await storage.signPart(key, id, 2, last.length, sha(last));
    const statuses = await Promise.all([
      ...Array.from({ length: 4 }, () => sendPart(one.url, one.headers, first)),
      sendPart(two.url, two.headers, last),
    ]);
    assert.ok(statuses.every((status) => status === 200));
    const parts = plannedParts(await storage.parts(key, id), first, last);
    await storage.complete(key, id, parts);
    uploads.delete(key);
    const expected = createHash('sha256').update(first).update(last).digest('base64');
    assert.deepEqual(await hashRead(key), { bytes: first.length + last.length, hash: expected });
  });
  await scenario(
    'pagination counts unique part numbers including 10000 after retries',
    async () => {
      const key = `staging/${randomUUID()}`;
      const id = await storage.initiate(key);
      uploads.set(key, id);
      const tiny = new Uint8Array(1024).fill(19);
      for (const number of [1, 2, 1000, 10000, 1, 10000]) {
        const signed = await storage.signPart(key, id, number, tiny.length, sha(tiny));
        assert.equal(await sendPart(signed.url, signed.headers, tiny), 200);
      }
      let marker: string | undefined;
      const numbers: number[] = [];
      for (let page = 0; page < 6; page++) {
        const raw = await storage.client.send(
          new ListPartsCommand({
            Bucket: bucket,
            Key: key,
            UploadId: id,
            MaxParts: 1,
            ...(marker ? { PartNumberMarker: marker } : {}),
          }),
        );
        numbers.push(...(raw.Parts ?? []).map((p) => p.PartNumber!));
        if (!raw.IsTruncated) break;
        assert.ok(raw.NextPartNumberMarker && raw.NextPartNumberMarker !== marker);
        marker = raw.NextPartNumberMarker;
      }
      observe('unique part pagination', numbers);
      assert.deepEqual(numbers, [1, 2, 1000, 10000]);
      await storage.abort(key, id);
      uploads.delete(key);
      await assert.rejects(storage.parts(key, id));
    },
  );
  await scenario('expired 120 second upload capability cannot store a part', async () => {
    const key = `staging/${randomUUID()}`;
    const id = await storage.initiate(key);
    uploads.set(key, id);
    const bytes = new Uint8Array(1024).fill(22);
    const checksum = sha(bytes);
    const url = await getSignedUrl(
      storage.client,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: id,
        PartNumber: 1,
        ContentLength: bytes.length,
        ChecksumSHA256: checksum,
      }),
      {
        expiresIn: 120,
        signingDate: new Date(Date.now() - 180000),
        signableHeaders: new Set(['content-length']),
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      },
    );
    assert.ok((await sendPart(url, { 'x-amz-checksum-sha256': checksum }, bytes)) >= 400);
    assert.deepEqual(await storage.parts(key, id), []);
    await storage.abort(key, id);
    uploads.delete(key);
  });
  await scenario('abort during an in-flight HTTP body cannot resurrect the upload', async () => {
    const key = `staging/${randomUUID()}`;
    const id = await storage.initiate(key);
    uploads.set(key, id);
    const signed = await storage.signPart(key, id, 1, first.length, sha(first));
    let continued!: () => void;
    let failed!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      continued = resolve;
      failed = reject;
    });
    let finish!: () => void;
    const result = new Promise<number>((resolve, reject) => {
      const req = request(
        signed.url,
        {
          method: 'PUT',
          headers: {
            ...signed.headers,
            'content-length': String(first.length),
            expect: '100-continue',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          failed(new Error('RESPONSE_BEFORE_UPLOAD_CONTINUED'));
        },
      );
      req.setTimeout(10000, () => req.destroy(new Error('TIMEOUT')));
      req.once('continue', () => {
        req.write(first.subarray(0, 1024), (error) => (error ? failed(error) : continued()));
      });
      req.on('error', (error) => {
        failed(error);
        reject(error);
      });
      finish = () => req.end(first.subarray(1024));
      req.flushHeaders();
    });
    void result.catch(() => {});
    await ready;
    await storage.abort(key, id);
    finish();
    const finishStatus = await result;
    observe('abort in-flight result', {
      status: finishStatus,
      objectExists: !!(await storage.head(key)),
      listAvailable: await storage.parts(key, id).then(
        () => true,
        () => false,
      ),
    });
    assert.ok(finishStatus >= 400);
    assert.equal(await storage.head(key), null);
    await assert.rejects(storage.parts(key, id));
    uploads.delete(key);
  });
} catch (error) {
  scenarios.push({
    name: 'fixture setup/protocol continuation',
    passed: false,
    error: (error as { name?: string }).name ?? 'Error',
  });
} finally {
  if (created) {
    await scenario('owned fixture cleanup', async () => {
      for (const [key, id] of uploads) await storage.abort(key, id);
      for (const key of keys) await storage.delete(key);
      await storage.client.send(new DeleteBucketCommand({ Bucket: bucket }));
    });
  }
  storage.close();
}
const report = {
  provider,
  observedAt: new Date().toISOString(),
  performanceMeasurement: false,
  scenarios,
  observations,
  passed: scenarios.every((s) => s.passed),
};
await writeFile(process.env.STORAGE_TEST_REPORT!, JSON.stringify(report, null, 2) + '\n');
console.log(
  `${provider}: ${scenarios.filter((s) => s.passed).length}/${scenarios.length} functional scenarios passed`,
);
process.exitCode = report.passed ? 0 : 1;
