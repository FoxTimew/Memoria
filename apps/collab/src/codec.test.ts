import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { build } from 'esbuild';
import { decodeDocument, validateCandidate, bounds } from './codec.ts';
import { representativeDocument, fixtureId } from './testing/fixture.ts';

function card(doc: Y.Doc) {
  return [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
    (node): node is Y.XmlElement =>
      node instanceof Y.XmlElement && node.nodeName === 'gamedevCharacterCard',
  )!;
}
describe('collaboration strict codec and isolated candidates', () => {
  it('decodes real BlockNote output: 300 blocks, nine types, nesting, links/styles and separate card fields', async () => {
    const { doc } = await representativeDocument();
    try {
      const blocks = decodeDocument(doc);
      expect(blocks).toHaveLength(300);
      expect(new Set(blocks.map((b) => b.type)).size).toBe(9);
      expect(blocks[5]!.parentId).toBe(fixtureId(5));
      expect(blocks[0]!.content.spans).toMatchObject([
        { styles: { bold: true } },
        { type: 'link', href: 'https://example.com/design' },
      ]);
      expect(blocks[8]!.content).toMatchObject({
        displayName: 'Personnage 8',
        tags: ['studio', 'quête'],
      });
      expect(validateCandidate(Y.encodeStateAsUpdate(doc), new Uint8Array([0, 0])).blocks).toEqual(
        blocks,
      );
    } finally {
      doc.destroy();
    }
  });
  it('converges independent fields, with one deterministic winner on the same field', async () => {
    const { doc } = await representativeDocument(9);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    try {
      card(doc).setAttribute('displayName', 'Alice');
      card(other).setAttribute('biography', 'B');
      card(doc).setAttribute('health', 71 as unknown as string);
      card(other).setAttribute('health', 22 as unknown as string);
      const a = Y.encodeStateAsUpdate(doc),
        b = Y.encodeStateAsUpdate(other);
      Y.applyUpdate(doc, b);
      Y.applyUpdate(other, a);
      expect(decodeDocument(doc)).toEqual(decodeDocument(other));
      expect(decodeDocument(doc)[8]!.content).toMatchObject({
        displayName: 'Alice',
        biography: 'B',
      });
      expect([71, 22]).toContain(decodeDocument(doc)[8]!.content.health);
    } finally {
      doc.destroy();
      other.destroy();
    }
  });
  it.each([
    'hidden-root',
    'invalid-field',
    'future-version',
    'unknown-attribute',
    'unknown-block',
    'duplicate-id',
    'unsafe-link',
    'embedded-object',
  ] as const)('rejects %s without mutating the accepted state', async (attack) => {
    const { doc } = await representativeDocument(9);
    try {
      const base = Y.encodeStateAsUpdate(doc);
      const nodes = [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)];
      if (attack === 'hidden-root') doc.getMap('secret').set('x', 'hidden');
      if (attack === 'invalid-field') card(doc).setAttribute('health', -1 as unknown as string);
      if (attack === 'future-version')
        card(doc).setAttribute('schemaVersion', 3 as unknown as string);
      if (attack === 'unknown-attribute') card(doc).setAttribute('data', '{}');
      if (attack === 'unknown-block') {
        const group = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
        const container = group.get(0) as Y.XmlElement;
        container.delete(0, 1);
        container.insert(0, [new Y.XmlElement('unknown')]);
      }
      if (attack === 'duplicate-id')
        (
          nodes.filter(
            (n) => n instanceof Y.XmlElement && n.nodeName === 'blockContainer',
          )[1] as Y.XmlElement
        ).setAttribute('id', fixtureId(1));
      const text = nodes.find((n): n is Y.XmlText => n instanceof Y.XmlText)!;
      if (attack === 'unsafe-link') text.format(0, 1, { link: { href: 'javascript:alert(1)' } });
      if (attack === 'embedded-object') text.insertEmbed(0, { script: 'hidden' });
      expect(() => validateCandidate(base, Y.encodeStateAsUpdate(doc))).toThrow();
      expect(validateCandidate(base, new Uint8Array([0, 0])).blocks).toHaveLength(9);
    } finally {
      doc.destroy();
    }
  });
  it('rejects missing dependencies and oversized updates', async () => {
    const { doc } = await representativeDocument(9);
    try {
      const source = new Y.Doc();
      source.getText('missing').insert(0, 'a');
      const before = Y.encodeStateVector(source);
      source.getText('missing').insert(1, 'b');
      expect(() =>
        validateCandidate(Y.encodeStateAsUpdate(doc), Y.encodeStateAsUpdate(source, before)),
      ).toThrow('dependencies');
      expect(() =>
        validateCandidate(Y.encodeStateAsUpdate(doc), new Uint8Array(bounds.update + 1)),
      ).toThrow('size');
      source.destroy();
    } finally {
      doc.destroy();
    }
  });
  it('keeps React/BlockNote unreachable from the production validation worker and journal', async () => {
    await build({
      entryPoints: [
        'apps/collab/src/service/incremental-worker.ts',
        'apps/collab/src/service/store.ts',
      ],
      outdir: '.local/unused',
      write: false,
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [
        {
          name: 'server-boundary',
          setup(builder) {
            builder.onResolve({ filter: /^(react(?:-dom)?(?:\/|$)|@blocknote\/)/ }, ({ path }) => ({
              errors: [{ text: `Forbidden server dependency ${path}` }],
            }));
          },
        },
      ],
    });
  });
});
