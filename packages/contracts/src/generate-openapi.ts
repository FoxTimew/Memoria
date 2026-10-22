import { mkdirSync, writeFileSync } from 'node:fs';
import { createOpenApiDocument } from './openapi.ts';

const directory = new URL('../../../docs/api/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(
  new URL('openapi.json', directory),
  `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`,
);
