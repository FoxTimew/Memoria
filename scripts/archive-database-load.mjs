import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { format, resolveConfig } from 'prettier';

// Lossless raw arrays in bounded NDJSON files: avoid duplicating them inside hygiene JSON.
const source = resolve(process.argv[2] ?? ''),
  destination = resolve(process.argv[3] ?? '');
const within = (root, path) => {
  const r = relative(resolve(root), path);
  return r.length > 0 && !r.startsWith('..') && !r.includes(':');
};
if (!within('.local', source) || !within('docs/reviews/evidence', destination))
  throw new Error('Expected a .local source and a new docs/reviews/evidence subdirectory');
await mkdir(destination, { recursive: false });
const hash = (s) => createHash('sha256').update(s).digest('hex');
const raw = await readFile(source),
  document = JSON.parse(raw.toString());
const originalReports = document.reports;
if (!Array.isArray(originalReports)) throw new Error('Expected load reports');
const files = [];
const formatting = await resolveConfig('package.json');
async function save(name, text) {
  if (name.endsWith('.json')) text = await format(text, { ...formatting, parser: 'json' });
  const bytes = Buffer.from(text);
  if (bytes.length > 18 * 1024 ** 2) throw new Error('Evidence shard exceeds 18 MiB');
  await writeFile(join(destination, name), bytes, { flag: 'wx' });
  files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
}
const hygienePaths = new Set();
function collect(value) {
  if (
    typeof value === 'string' &&
    value.startsWith('.local/measurement-hygiene/') &&
    value.endsWith('.json')
  )
    hygienePaths.add(value);
  else if (value && typeof value === 'object')
    for (const child of Object.values(value)) collect(child);
}
collect(document);
const reports = [];
for (let index = 0; index < originalReports.length; index++) {
  const report = { ...originalReports[index] },
    arrays = {};
  for (const [key, value] of Object.entries(report))
    if (Array.isArray(value) && value.length > 100) {
      const names = [];
      for (let start = 0; start < value.length; start += 10000) {
        const name = `series-${index + 1}-${key}-${Math.floor(start / 10000) + 1}.ndjson`;
        await save(
          name,
          value
            .slice(start, start + 10000)
            .map((row) => JSON.stringify(row))
            .join('\n') + '\n',
        );
        names.push(name);
      }
      arrays[key] = { count: value.length, sha256: hash(JSON.stringify(value)), files: names };
      delete report[key];
    }
  reports.push({ ...report, rawArrays: arrays });
}
const hygiene = [];
for (const path of hygienePaths) {
  const bytes = await readFile(path),
    item = JSON.parse(bytes.toString());
  const { result, ...metadata } = item;
  const name = basename(path);
  await save(
    name,
    JSON.stringify(
      {
        ...metadata,
        ...(result === undefined
          ? {}
          : {
              resultSha256: hash(JSON.stringify(result)),
              resultStorage:
                'The series raw arrays and summary retain the measurement result; original full hygiene file remains in .local.',
            }),
      },
      null,
      2,
    ) + '\n',
  );
  hygiene.push({ source: path, file: name, originalSha256: hash(bytes) });
}
await save('measurement.json', JSON.stringify({ ...document, reports }, null, 2) + '\n');
await writeFile(
  join(destination, 'index.json'),
  JSON.stringify(
    {
      source: relative(resolve('.'), source),
      originalSha256: hash(raw),
      encoding:
        'JSON summaries + ordered, compact NDJSON shards, no samples removed. Array hashes use JSON.stringify(array). Hygiene result duplicates are replaced by their SHA256.',
      hygiene,
      files,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(
  `Archived ${originalReports.length} series and ${hygiene.length} hygiene files to ${relative(resolve('.'), destination)}`,
);
