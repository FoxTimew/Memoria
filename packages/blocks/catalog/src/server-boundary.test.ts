import { mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Include JSX runtimes, React DOM and type-only React dependencies as well.
const forbidden = /^(?:react(?:-dom)?(?:\/|$)|@types\/react(?:-dom)?(?:\/|$)|@blocknote\/)/;

async function assertServerBoundary(entry: string): Promise<void> {
  // TypeScript follows workspace exports and type-only edges that bundlers erase.
  // types: [] prevents ambient test dependencies from polluting this isolated graph.
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowImportingTsExtensions: true,
    noEmit: true,
    types: [],
  });
  for (const source of program.getSourceFiles()) {
    const references = ts.preProcessFile(source.text, true, true);
    for (const reference of [...references.importedFiles, ...references.typeReferenceDirectives]) {
      if (forbidden.test(reference.fileName)) {
        throw new Error(
          `UI dependency forbidden in server graph: ${reference.fileName} from ${source.fileName}`,
        );
      }
    }
  }

  // Also follow runtime JS of third-party packages, not just their declarations.
  // Disable tree shaking so an unused re-export cannot hide a forbidden edge.
  await build({
    absWorkingDir: dirname(entry),
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    treeShaking: false,
    ignoreAnnotations: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'server-without-ui',
        setup(builder) {
          builder.onResolve({ filter: forbidden }, (args) => ({
            errors: [
              {
                text: `UI dependency forbidden in server graph: ${args.path} from ${args.importer}`,
              },
            ],
          }));
        },
      },
    ],
  });
}

describe('server block dependency boundary', () => {
  it('keeps the public server export and blocks-core free from UI dependencies', async () => {
    const entry = fileURLToPath(import.meta.resolve('@memoria/block-catalog/server'));
    await assertServerBoundary(entry);
    const coreManifest = JSON.parse(
      readFileSync(new URL('../../core/package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(
      Object.keys({
        ...coreManifest.dependencies,
        ...coreManifest.devDependencies,
        ...coreManifest.peerDependencies,
      }).filter((name) => forbidden.test(name)),
    ).toEqual([]);
  });

  it.each([
    "export { createElement } from 'react';",
    "export { jsx } from 'react/jsx-runtime';",
    "export { renderToStaticMarkup } from 'react-dom/server';",
    "export const load = () => import('@blocknote/core');",
    "export type { ComponentType } from 'react';",
    "export type Spec = import('@blocknote/react').ReactCustomBlockImplementation;",
  ])('rejects a transitive edge even through a re-export: %s', async (source) => {
    const directory = mkdtempSync(join(tmpdir(), 'memoria-block-boundary-'));
    try {
      const entry = join(directory, 'server.ts');
      writeFileSync(entry, "export * from './bridge.ts';\n");
      writeFileSync(join(directory, 'bridge.ts'), source);
      await expect(assertServerBoundary(entry)).rejects.toThrow('UI dependency forbidden');
    } finally {
      for (const file of readdirSync(directory)) rmSync(join(directory, file));
      rmdirSync(directory);
    }
  });

  it('checks runtime JavaScript even when its declarations have no UI dependency', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memoria-block-boundary-'));
    try {
      const entry = join(directory, 'server.ts');
      writeFileSync(entry, "export * from './bridge.js';\n");
      writeFileSync(join(directory, 'bridge.d.ts'), 'export declare const load: () => unknown;');
      writeFileSync(
        join(directory, 'bridge.js'),
        "export const load = () => import('@blocknote/core');",
      );
      await expect(assertServerBoundary(entry)).rejects.toThrow('UI dependency forbidden');
    } finally {
      for (const file of readdirSync(directory)) rmSync(join(directory, file));
      rmdirSync(directory);
    }
  });
});
