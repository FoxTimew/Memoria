/** Deployment configuration, never accepted from HTTP input. Increases require a recorded measurement. */
export const databaseLimitDefaults = {
  rowsPerBase: 10_000,
  rowsPerWorkspace: 50_000,
  basesPerWorkspace: 50,
  propertiesPerBase: 50,
  optionsPerProperty: 100,
  relationValues: 50,
  setValues: 20,
  pageSize: 50,
  maxPageSize: 100,
  textCharacters: 2_000,
  urlCharacters: 2_048,
  labelCharacters: 80,
  assignablePeople: 100,
  savedViews: 1,
  sorts: 2,
  filters: 10,
  filterValues: 20,
  mutationBytes: 65_536,
  queryBytes: 16_384,
  accessIds: 100,
  responseBytes: 4_194_304,
  queryTimeoutMs: 2_000,
  concurrentQueries: 16,
  queuedQueries: 32,
} as const;
export type DatabaseLimits = { readonly [K in keyof typeof databaseLimitDefaults]: number };
export function databaseLimitVariable(key: string) {
  return 'DATABASE_' + key.replace(/[A-Z]/g, (s) => '_' + s).toUpperCase();
}
export function readDatabaseLimits(env: NodeJS.ProcessEnv = process.env): DatabaseLimits {
  const result = Object.fromEntries(
    Object.entries(databaseLimitDefaults).map(([key, fallback]) => {
      const name = databaseLimitVariable(key),
        raw = env[name];
      if (raw !== undefined && (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))))
        throw new Error(`Invalid deployment limit ${name}: expected a positive safe integer`);
      return [key, raw === undefined ? fallback : Number(raw)];
    }),
  ) as unknown as DatabaseLimits;
  if (result.rowsPerBase > result.rowsPerWorkspace || result.pageSize > result.maxPageSize)
    throw new Error('Inconsistent DATABASE deployment limits');
  return Object.freeze(result);
}
