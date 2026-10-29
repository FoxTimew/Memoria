import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
  CreateBucketCommand,
  PutBucketCorsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface StoragePart {
  number: number;
  bytes: number;
  etag: string;
  checksum?: string;
}
export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  publicEndpoint?: string;
}

/** Streaming transport. The UploadService owns authorization, reservation and keys.
 * Browser capabilities are restricted to POST and UploadPart. */
export class S3ObjectStorage {
  readonly client: S3Client;
  readonly publicClient: S3Client;
  constructor(readonly config: StorageConfig) {
    this.client = new S3Client({
      ...config,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 5000, socketTimeout: 30000 },
    });
    this.publicClient = new S3Client({
      ...config,
      endpoint: config.publicEndpoint ?? config.endpoint,
      forcePathStyle: true,
      maxAttempts: 1,
    });
  }
  close() {
    this.client.destroy();
    this.publicClient.destroy();
  }
  private key(key: string) {
    if (!/^(staging|objects)\/[a-zA-Z0-9/-]{1,200}$/.test(key))
      throw new Error('INVALID_OBJECT_KEY');
    return { Bucket: this.config.bucket, Key: key };
  }
  private upload(key: string) {
    if (!key.startsWith('staging/')) throw new Error('IMMUTABLE_OBJECT');
    return this.key(key);
  }
  private bytes(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 5 * 1024 ** 3)
      throw new Error('INVALID_OBJECT_SIZE');
  }
  async createUpload(key: string, bytes: number, expires = 120) {
    this.bytes(bytes);
    return createPresignedPost(this.publicClient, {
      ...this.upload(key),
      Expires: expires,
      Fields: { 'Content-Type': 'application/octet-stream' },
      Conditions: [['content-length-range', bytes, bytes]],
    });
  }
  async initiate(key: string) {
    const r = await this.client.send(
      new CreateMultipartUploadCommand({
        ...this.upload(key),
        ContentType: 'application/octet-stream',
        ChecksumAlgorithm: 'SHA256',
      }),
    );
    if (!r.UploadId) throw new Error('INVALID_STORAGE_RESPONSE');
    return r.UploadId;
  }
  async signPart(
    key: string,
    upload: string,
    number: number,
    bytes: number,
    checksum: string,
    expires = 120,
  ) {
    this.bytes(bytes);
    if (!Number.isInteger(number) || number < 1 || number > 10000)
      throw new Error('INVALID_PART_NUMBER');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(checksum)) throw new Error('INVALID_CHECKSUM');
    const url = await getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        ...this.upload(key),
        UploadId: upload,
        PartNumber: number,
        ContentLength: bytes,
        ChecksumSHA256: checksum,
      }),
      {
        expiresIn: expires,
        signableHeaders: new Set(['content-length']),
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      },
    );
    return { url, headers: { 'x-amz-checksum-sha256': checksum } };
  }
  async parts(key: string, upload: string): Promise<StoragePart[]> {
    const result: StoragePart[] = [];
    let marker: string | undefined;
    do {
      const r = await this.client.send(
        new ListPartsCommand({
          ...this.upload(key),
          UploadId: upload,
          PartNumberMarker: marker,
          MaxParts: 1000,
        }),
      );
      for (const p of r.Parts ?? []) {
        if (!p.PartNumber || p.Size === undefined || !p.ETag)
          throw new Error('INVALID_STORAGE_RESPONSE');
        result.push({
          number: p.PartNumber,
          bytes: p.Size,
          etag: p.ETag,
          ...(p.ChecksumSHA256 ? { checksum: p.ChecksumSHA256 } : {}),
        });
      }
      const next = r.IsTruncated ? r.NextPartNumberMarker : undefined;
      if (
        result.length > 10000 ||
        (r.IsTruncated && (!next || Number(next) <= Number(marker ?? 0)))
      )
        throw new Error('INVALID_STORAGE_RESPONSE');
      marker = next;
    } while (marker);
    return result;
  }
  async complete(key: string, upload: string, parts: StoragePart[]) {
    // Service must compare this server-derived list to its reserved immutable plan.
    await this.client.send(
      new CompleteMultipartUploadCommand({
        ...this.upload(key),
        UploadId: upload,
        MultipartUpload: {
          Parts: parts.map((p) => ({
            PartNumber: p.number,
            ETag: p.etag,
            ...(p.checksum ? { ChecksumSHA256: p.checksum } : {}),
          })),
        },
      }),
    );
  }
  async abort(key: string, upload: string) {
    await this.client.send(
      new AbortMultipartUploadCommand({ ...this.upload(key), UploadId: upload }),
    );
  }
  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand(this.key(key)));
      if (r.ContentLength === undefined || !r.ETag) throw new Error('INVALID_STORAGE_RESPONSE');
      return { bytes: r.ContentLength, etag: r.ETag };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return null;
      throw error;
    }
  }
  async copy(source: string, target: string) {
    if (!target.startsWith('objects/')) throw new Error('INVALID_OBJECT_KEY');
    this.upload(source);
    await this.client.send(
      new CopyObjectCommand({
        ...this.key(target),
        CopySource: [this.config.bucket, ...source.split('/')].map(encodeURIComponent).join('/'),
        ContentType: 'application/octet-stream',
        MetadataDirective: 'REPLACE',
      }),
    );
  }
  async read(key: string, range?: { start: number; end: number }) {
    if (
      range &&
      (!Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start)
    )
      throw new Error('INVALID_RANGE');
    const r = await this.client.send(
      new GetObjectCommand({
        ...this.key(key),
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    if (!r.Body) throw new Error('INVALID_STORAGE_RESPONSE');
    return r.Body as AsyncIterable<Uint8Array>;
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand(this.key(key)));
  }
  async uploads(key: string) {
    this.upload(key);
    const result = await this.client.send(
      new ListMultipartUploadsCommand({
        Bucket: this.config.bucket,
        Prefix: key,
        MaxUploads: 1000,
      }),
    );
    if (result.IsTruncated) throw new Error('STORAGE_INVENTORY_LIMIT');
    return (result.Uploads ?? [])
      .filter((u) => u.Key === key && u.UploadId)
      .map((u) => u.UploadId!);
  }
  async initialize(origin: string) {
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
    } catch (error) {
      if (!['BucketAlreadyExists', 'BucketAlreadyOwnedByYou'].includes((error as Error).name))
        throw error;
    }
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.config.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [origin],
              AllowedMethods: ['POST', 'PUT'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag', 'x-amz-checksum-sha256'],
              MaxAgeSeconds: 300,
            },
          ],
        },
      }),
    );
  }
}
