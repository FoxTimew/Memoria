/** Deployment settings. Raising a default requires a measured qualification (ADR 022). */
export const fileLimitDefaults = {
  maxBytes: 5 * 1024 ** 3,
  workspaceBytes: 250 * 1024 ** 3,
  workspaceFiles: 100000,
  pageReferences: 100,
  fileUsages: 1000,
  cellFiles: 20,
  derivativeBytes: 10 * 1024 ** 2,
  partBytes: 16 * 1024 ** 2,
  bytesPerSecond: 10 * 1024 ** 2,
  burstBytes: 64 * 1024 ** 2,
  activeFiles: 2,
  activeParts: 4,
  instanceParts: 20,
  urlSeconds: 120,
  resumeSeconds: 24 * 3600,
  absoluteSeconds: 7 * 24 * 3600,
  copyBytes: 20 * 1024 ** 3,
} as const;
export type FileLimits = { -readonly [K in keyof typeof fileLimitDefaults]: number };
export const fileLimitVariable = (key: keyof FileLimits) =>
  'FILES_' + key.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();
export function readFileLimits(env: NodeJS.ProcessEnv = process.env): FileLimits {
  const values = {} as FileLimits;
  for (const [key, fallback] of Object.entries(fileLimitDefaults)) {
    const k = key as keyof FileLimits,
      raw = env[fileLimitVariable(k)];
    const value = raw === undefined ? fallback : Number(raw);
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      (raw !== undefined && !/^[1-9][0-9]*$/.test(raw))
    )
      throw new Error(`Invalid ${fileLimitVariable(k)}`);
    values[k] = value;
  }
  if (
    values.partBytes > values.burstBytes ||
    values.activeParts > values.instanceParts ||
    values.resumeSeconds > values.absoluteSeconds
  )
    throw new Error('Incompatible file limits');
  return values;
}
