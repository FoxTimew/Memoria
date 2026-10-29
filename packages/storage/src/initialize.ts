import { S3ObjectStorage } from './index.ts';
import { storageConfig } from './config.ts';
const origin = new URL(process.env.APP_ORIGIN!);
if (origin.protocol !== 'https:' || origin.origin !== process.env.APP_ORIGIN)
  throw new Error('Invalid APP_ORIGIN');
const storage = new S3ObjectStorage(storageConfig());
try {
  await storage.initialize(origin.origin);
  console.log('Private storage bucket and exact upload CORS initialized.');
} finally {
  storage.close();
}
