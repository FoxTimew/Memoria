/** Called only after the shared authorization service has checked a page grant. */
export interface ObjectStorage {
  createUpload(input: {
    objectKey: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<{ url: string; method: 'POST'; fields: Record<string, string> }>;
  createDownload(input: {
    objectKey: string;
    expiresInSeconds: number;
    filename: string;
  }): Promise<{ url: string; expiresAt: Date }>;
  head(objectKey: string): Promise<{ bytes: number; contentType: string; etag: string } | null>;
  delete(objectKey: string): Promise<void>;
}
