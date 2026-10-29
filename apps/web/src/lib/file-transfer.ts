import { sha256 } from '@noble/hashes/sha2.js';
import { contentRequest } from './content-api.ts';

export type UploadStatus = {
  id: string;
  name: string;
  state: string;
  bytes: number;
  checksum: string;
  mode: 'post' | 'multipart';
  partBytes: number;
  preview: string;
  mime: string;
};
export type FileMetadata = {
  id: string;
  name: string;
  bytes: number;
  mime: string;
  preview: string;
  version: number;
  width: number | null;
  height: number | null;
};
export type UploadProgress = {
  phase: 'hashing' | 'sending' | 'checking';
  done: number;
  total: number;
};
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
// Only safe, bounded derivatives enter JS. Two reads per tab; originals stream via the browser.
let previewReads = 0;
const previewWaiters: (() => void)[] = [];
export async function readPreview(url: string, signal: AbortSignal) {
  if (previewReads >= 2) await new Promise<void>((r) => previewWaiters.push(r));
  else previewReads++;
  try {
    signal.throwIfAborted();
    const response = await fetch(url, {
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (!response.ok || response.headers.get('content-type') !== 'image/webp' || !response.body) {
      await response.body?.cancel();
      throw Error('Aperçu indisponible.');
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 10 * 1024 ** 2) throw Error('Aperçu trop volumineux.');
        chunks.push(Uint8Array.from(value));
      }
    } finally {
      await reader.cancel();
    }
    signal.throwIfAborted();
    return new Blob(chunks, { type: 'image/webp' });
  } finally {
    const next = previewWaiters.shift();
    if (next) next();
    else previewReads--;
  }
}
/** Hash in chunks of at most 1 MiB, including the whole-file digest. Never arrayBuffer(file). */
export async function fileDigest(blob: Blob, signal: AbortSignal, progress?: (n: number) => void) {
  const hash = sha256.create();
  try {
    for (let offset = 0; offset < blob.size; offset += 1024 ** 2) {
      signal.throwIfAborted();
      hash.update(new Uint8Array(await blob.slice(offset, offset + 1024 ** 2).arrayBuffer()));
      progress?.(Math.min(blob.size, offset + 1024 ** 2));
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    signal.throwIfAborted();
    return b64(hash.digest());
  } finally {
    hash.destroy();
  }
}
export async function fileRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return (await contentRequest(path, method, body, signal)) as T;
}
/** Suspended requests cannot publish into a new page/session after revocation or logout. */
export class FileLifetime {
  constructor(private readonly allowed: () => boolean = () => true) {}
  private controller = new AbortController();
  private revision = 0;
  private closed = false;
  capture() {
    const revision = this.revision,
      signal = this.controller.signal;
    return {
      signal,
      check: () => {
        signal.throwIfAborted();
        if (this.closed || revision !== this.revision || !this.allowed())
          throw new DOMException('Fichier fermé', 'AbortError');
      },
    };
  }
  reset() {
    this.controller.abort();
    this.controller = new AbortController();
    this.revision++;
    if (this.closed) this.controller.abort();
  }
  close() {
    this.closed = true;
    this.reset();
  }
}
export function riskyDownload(name: string, mime: string) {
  // Unknown types are intentionally cautious. The original always stays an attachment.
  return (
    ![
      'image/jpeg',
      'image/png',
      'image/webp',
      'audio/mpeg',
      'audio/wav',
      'video/mp4',
      'video/webm',
      'text/plain',
      'application/pdf',
    ].includes(mime) ||
    /\.(exe|dll|msi|com|scr|bat|cmd|ps1|sh|bash|zsh|js|mjs|cjs|vbs|hta|jar|py|rb|pl|php|html?|svgz?|zip|rar|7z|tar|gz|bz2|xz|iso|dmg|pkg|app|apk)(?:[.\s]|$)/i.test(
      name,
    )
  );
}
export async function uploadFile(
  endpoint: string,
  pageId: string,
  file: File,
  signal: AbortSignal,
  progress: (p: UploadProgress) => void,
  resumeId?: string,
) {
  const checksum = await fileDigest(file, signal, (done) =>
    progress({ phase: 'hashing', done, total: file.size }),
  );
  let status: UploadStatus;
  let known: { number: number; bytes: number; checksum: string }[] = [];
  if (resumeId) {
    status = await fileRequest<UploadStatus>(`${endpoint}/${resumeId}`, 'GET', undefined, signal);
    if (status.bytes !== file.size || status.checksum !== checksum)
      throw Error('Ce fichier ne correspond pas à celui commencé. Choisissez le fichier original.');
    const resumed = await fileRequest<UploadStatus & { parts: typeof known }>(
      `${endpoint}/${resumeId}/resume`,
      'POST',
      {},
      signal,
    );
    status = resumed;
    known = resumed.parts;
  } else
    status = await fileRequest<UploadStatus>(
      endpoint,
      'POST',
      { pageId, name: file.name, bytes: file.size, checksum, idempotency: crypto.randomUUID() },
      signal,
    );
  if (status.state !== 'uploading') return status;
  const partBytes = status.mode === 'post' ? file.size : status.partBytes;
  for (let offset = 0, number = 1; offset < file.size; offset += partBytes, number++) {
    signal.throwIfAborted();
    const started = Date.now(),
      part = file.slice(offset, Math.min(file.size, offset + partBytes));
    const checksum = await fileDigest(part, signal),
      previous = known.find((p) => p.number === number);
    if (previous) {
      if (previous.bytes !== part.size || previous.checksum !== checksum)
        throw Error('La reprise ne correspond plus au fichier original.');
    } else {
      const signed = await fileRequest<{
        signatures: {
          number: number;
          url?: string;
          headers?: Record<string, string>;
          post?: { url: string; fields: Record<string, string> };
        }[];
      }>(
        `${endpoint}/${status.id}/parts`,
        'POST',
        { request: crypto.randomUUID(), parts: [{ number, bytes: part.size, checksum }] },
        signal,
      );
      const s = signed.signatures[0]!;
      let body: BodyInit = part;
      if (s.post) {
        const form = new FormData();
        for (const [k, v] of Object.entries(s.post.fields)) form.append(k, v);
        form.append('file', part);
        body = form;
      }
      const response = await fetch(s.post?.url ?? s.url!, {
        method: s.post ? 'POST' : 'PUT',
        body,
        headers: s.post ? {} : (s.headers ?? {}),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal,
      }).catch(() => {
        signal.throwIfAborted();
        throw Error('Envoi interrompu. Réessayez en choisissant le même fichier pour reprendre.');
      });
      if (!response.ok)
        throw Error('Envoi interrompu. Réessayez en choisissant le même fichier pour reprendre.');
      // Below the default 10 MiB/s admission budget, one outstanding part. The server is authoritative.
      const delay = (part.size / (8 * 1024 ** 2)) * 1000 - (Date.now() - started);
      if (delay > 0 && offset + partBytes < file.size)
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', stop);
            resolve();
          }, delay);
          signal.addEventListener('abort', stop, { once: true });
        });
    }
    progress({ phase: 'sending', done: Math.min(file.size, offset + partBytes), total: file.size });
  }
  progress({ phase: 'checking', done: file.size, total: file.size });
  return fileRequest<UploadStatus>(`${endpoint}/${status.id}/complete`, 'POST', {}, signal);
}
