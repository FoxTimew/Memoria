import type { StorageConfig } from './index.ts';
export function storageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const required = [
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ] as const;
  for (const field of required) if (!env[field]) throw new Error('Missing storage field: ' + field);
  const endpoint = new URL(env.S3_ENDPOINT!),
    publicUrl = new URL(env.S3_PUBLIC_ENDPOINT!);
  if (
    ![endpoint, publicUrl].every(
      (u) =>
        ['http:', 'https:'].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === '/',
    )
  )
    throw new Error('Invalid storage origin');
  if (
    env.NODE_ENV !== 'test' &&
    (publicUrl.protocol !== 'https:' || publicUrl.hostname === new URL(env.APP_ORIGIN!).hostname)
  )
    throw new Error('Storage needs a separate HTTPS hostname');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET!))
    throw new Error('Invalid S3_BUCKET');
  return {
    endpoint: endpoint.origin,
    publicEndpoint: publicUrl.origin,
    region: env.S3_REGION ?? 'us-east-1',
    bucket: env.S3_BUCKET!,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
  };
}
