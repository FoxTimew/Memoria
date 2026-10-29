import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { IncrementalReplica } from './incremental-replica.ts';
import { representativeDocument, fixtureId } from '../testing/fixture.ts';
import { contentFixture } from '../testing/content-fixture.ts';
import { decodeDocument, validateCandidate, bounds } from '../codec.ts';
const nodes = (doc: Y.Doc) => [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)];
const card = (doc: Y.Doc) =>
  nodes(doc).find(
    (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
  )!;
const text = (doc: Y.Doc) => nodes(doc).find((n): n is Y.XmlText => n instanceof Y.XmlText)!;
function change(doc: Y.Doc, edit: () => void) {
  let update!: Uint8Array;
  const capture = (u: Uint8Array) => {
    update = u;
  };
  doc.on('update', capture);
  doc.transact(edit);
  doc.off('update', capture);
  return update;
}
describe('persistent incremental candidate versus full validator', () => {
  it('keeps author-step introductions even when a later contribution removes the file', async () => {
    const { doc } = await representativeDocument(9),
      replica = new IncrementalReplica(Y.encodeStateAsUpdate(doc));
    try {
      const image = nodes(doc).find(
        (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'memoriaImage',
      )!;
      const file = fixtureId(5000);
      const first = change(doc, () => image.setAttribute('fileId', file));
      const second = change(doc, () => image.setAttribute('fileId', ''));
      const candidate = replica.prepareMany([first, second]);
      expect(candidate.files).toEqual([]);
      expect(candidate.fileSteps[0]!.added.map((r) => r.file)).toEqual([file]);
      expect(candidate.fileSteps[1]!.removed.map((r) => r.file)).toEqual([file]);
      replica.abort();
      expect(replica.prepareMany([first, second]).fileSteps).toEqual(candidate.fileSteps);
      replica.commit();
      expect(replica.inspect()).toEqual(decodeDocument(doc));
    } finally {
      replica.close();
      doc.destroy();
    }
  });
  it('reuses ownership only after commit, retries after abort, and rechecks newly introduced IDs', async () => {
    const { doc } = await representativeDocument(9),
      replica = new IncrementalReplica(Y.encodeStateAsUpdate(doc));
    try {
      const first = change(doc, () => text(doc).insert(0, 'first'));
      const allIds = replica.inspect().map((block) => block.id);
      expect(replica.prepare(first).blockIdsToReserve).toEqual(allIds);
      replica.abort();
      expect(replica.prepare(first).blockIdsToReserve).toEqual(allIds);
      replica.commit();
      expect(
        replica.prepare(change(doc, () => text(doc).insert(0, 'second'))).blockIdsToReserve,
      ).toEqual([]);
      replica.commit();
      const group = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement,
        copy = (group.get(0) as Y.XmlElement).clone(),
        id = fixtureId(900);
      // Copy a leaf to avoid duplicating descendants' IDs.
      while (copy.length > 1) copy.delete(1, 1);
      copy.setAttribute('id', id);
      const inserted = change(doc, () => group.insert(group.length, [copy]));
      expect(replica.prepare(inserted).blockIdsToReserve).toEqual([id]);
      replica.abort();
      expect(replica.prepare(inserted).blockIdsToReserve).toEqual([id]);
      replica.commit();
      const again = copy.clone();
      replica.prepare(change(doc, () => group.delete(group.length - 1, 1)));
      replica.commit();
      expect(
        replica.prepare(change(doc, () => group.insert(group.length, [again]))).blockIdsToReserve,
      ).toEqual([id]);
      replica.commit();
      const reloaded = new IncrementalReplica(replica.snapshot());
      try {
        expect(
          reloaded.prepare(change(doc, () => text(doc).insert(0, 'reload'))).blockIdsToReserve,
        ).toEqual(replica.inspect().map((block) => block.id));
      } finally {
        reloaded.close();
      }
    } finally {
      replica.close();
      doc.destroy();
    }
  });
  it('loads a journal in one replay and rolls back to its durable content without losing deletions', async () => {
    const { doc } = await representativeDocument(30);
    const snapshot = Y.encodeStateAsUpdate(doc),
      updates: Uint8Array[] = [];
    let replica: IncrementalReplica | undefined;
    try {
      for (let i = 0; i < 80; i++)
        updates.push(
          change(doc, () => {
            if (i % 3 === 0) card(doc).setAttribute('health', (100 + i) as unknown as string);
            else if (i % 3 === 1) text(doc).insert(0, 'é👾');
            else text(doc).delete(0, 1);
          }),
        );
      replica = new IncrementalReplica(snapshot, updates);
      expect(replica.inspect()).toEqual(decodeDocument(doc));
      expect(replica.snapshot()).toEqual(Y.encodeStateAsUpdate(doc));
      const durable = replica.snapshot();
      expect(() =>
        replica!.prepare(change(doc, () => card(doc).setAttribute('health', 'invalid'))),
      ).toThrow();
      replica.abort();
      expect(replica.snapshot()).toEqual(durable);
      const client = new Y.Doc();
      client.getXmlFragment('prosemirror');
      Y.applyUpdate(client, durable);
      try {
        const result = replica.prepare(change(client, () => text(client).insert(0, 'safe')));
        replica.commit();
        expect(replica.snapshot().length).toBeLessThanOrEqual(result.encodedUpperBound);
        expect(replica.inspect()).toEqual(decodeDocument(client));
      } finally {
        client.destroy();
      }
    } finally {
      replica?.close();
      doc.destroy();
    }
  });
  it('revalidates only touched content and preserves exact JSON accounting through text, marks and fields', async () => {
    const { doc } = await representativeDocument();
    const replica = new IncrementalReplica(Y.encodeStateAsUpdate(doc));
    try {
      for (let i = 0; i < 60; i++) {
        const base = replica.snapshot();
        const update = change(doc, () => {
          if (i % 3 === 0) card(doc).setAttribute('health', (200 + i) as unknown as string);
          else if (i % 3 === 1) text(doc).insert(0, 'é👾');
          else text(doc).format(0, 1, { bold: {} });
        });
        const result = replica.prepare(update);
        expect(result.checkedBlocks).toBeLessThanOrEqual(1);
        expect(replica.inspect()).toEqual(validateCandidate(base, update).blocks);
        expect(result.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(replica.inspect())));
        replica.commit();
        expect(replica.snapshot().length).toBeLessThanOrEqual(result.encodedUpperBound);
      }
    } finally {
      replica.close();
      doc.destroy();
    }
  });
  it('checks IDs, nesting and order after subtree replacement, insertion and deletion', async () => {
    const { doc } = await representativeDocument(30);
    const replica = new IncrementalReplica(Y.encodeStateAsUpdate(doc));
    try {
      const group = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
      for (let i = 0; i < 12; i++) {
        const base = replica.snapshot();
        const update = change(doc, () => {
          const copy = (group.get(0) as Y.XmlElement).clone();
          group.delete(0, 1);
          group.insert(group.length, [copy]);
        });
        replica.prepare(update);
        expect(replica.inspect()).toEqual(validateCandidate(base, update).blocks);
        replica.commit();
      }
      const base = replica.snapshot();
      const update = change(doc, () => group.delete(0, 1));
      replica.prepare(update);
      expect(replica.inspect()).toEqual(validateCandidate(base, update).blocks);
      replica.commit();
    } finally {
      replica.close();
      doc.destroy();
    }
  });
  it.each([
    'hidden-root',
    'invalid-field',
    'unknown-attribute',
    'future-version',
    'unsafe-link',
    'embedded-object',
    'duplicate-id',
    'unknown-node',
    'empty-group',
    'root-attribute',
  ] as const)('rejects %s then reconstructs the accepted state', async (attack) => {
    const { doc } = await representativeDocument(18);
    const base = Y.encodeStateAsUpdate(doc),
      replica = new IncrementalReplica(base);
    try {
      const update = change(doc, () => {
        if (attack === 'hidden-root') doc.getMap('hidden').set('x', 1);
        if (attack === 'invalid-field') card(doc).setAttribute('health', -1 as unknown as string);
        if (attack === 'future-version')
          card(doc).setAttribute('schemaVersion', 99 as unknown as string);
        if (attack === 'unknown-attribute') card(doc).setAttribute('data', '{}');
        if (attack === 'unsafe-link')
          text(doc).format(0, 1, { link: { href: 'javascript:alert(1)' } });
        if (attack === 'embedded-object') text(doc).insertEmbed(0, { hidden: 'x' });
        const group = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
        if (attack === 'duplicate-id')
          (group.get(1) as Y.XmlElement).setAttribute('id', fixtureId(1));
        if (attack === 'unknown-node') {
          const container = group.get(0) as Y.XmlElement;
          container.delete(0, 1);
          container.insert(0, [new Y.XmlElement('unknown')]);
        }
        if (attack === 'empty-group') group.delete(0, group.length);
        if (attack === 'root-attribute') {
          const hostile = new Y.Doc();
          hostile.getMap('prosemirror').set('hidden', 1);
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(hostile));
          hostile.destroy();
        }
      });
      expect(() => validateCandidate(base, update)).toThrow();
      expect(() => replica.prepare(update)).toThrow();
      replica.abort();
      expect(replica.snapshot()).toEqual(base);
    } finally {
      replica.close();
      doc.destroy();
    }
  });
  it('rejects business overflow at 500 blocks without trusting a stale content byte cache', async () => {
    const { doc } = await contentFixture();
    const base = Y.encodeStateAsUpdate(doc),
      replica = new IncrementalReplica(base);
    try {
      const last = nodes(doc)
        .filter(
          (n): n is Y.XmlElement =>
            n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
        )
        .at(-1)!;
      const update = change(doc, () => last.setAttribute('biography', '👾'.repeat(5000)));
      expect(() => validateCandidate(base, update)).toThrow('JSON');
      expect(() => replica.prepare(update)).toThrow('JSON');
      replica.abort();
      expect(replica.inspect()).toEqual(decodeDocument(replica.doc));
    } finally {
      replica.close();
      doc.destroy();
    }
  });
  it('does not poison the replica on missing dependencies, malformed data or SQL abort', async () => {
    const { doc } = await representativeDocument(9);
    const replica = new IncrementalReplica(Y.encodeStateAsUpdate(doc));
    try {
      const accepted = change(doc, () => text(doc).insert(0, 'committed'));
      replica.prepare(accepted);
      replica.commit();
      const base = replica.snapshot();
      const uncommitted = change(doc, () => text(doc).insert(0, 'not committed'));
      replica.prepare(uncommitted);
      replica.abort();
      expect(replica.snapshot()).toEqual(base);
      const missing = new Y.Doc();
      missing.getText('missing').insert(0, 'a');
      const sv = Y.encodeStateVector(missing);
      missing.getText('missing').insert(1, 'b');
      expect(() => replica.prepare(Y.encodeStateAsUpdate(missing, sv))).toThrow('dependencies');
      replica.abort();
      missing.destroy();
      expect(() => replica.prepare(new Uint8Array([255]))).toThrow();
      replica.abort();
      expect(replica.snapshot()).toEqual(base);
      expect(() => replica.prepare(new Uint8Array(bounds.update + 1))).toThrow('size');
    } finally {
      replica.close();
      doc.destroy();
    }
  });
});

it.each(['count', 'depth'] as const)(
  'enforces global %s after structural changes outside cached content',
  async (kind) => {
    const { doc } = await representativeDocument(9);
    const base = Y.encodeStateAsUpdate(doc),
      replica = new IncrementalReplica(base);
    try {
      const group = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
      const template = nodes(doc).find(
        (n): n is Y.XmlElement =>
          n instanceof Y.XmlElement && n.nodeName === 'blockContainer' && n.length === 1,
      )!;
      const copies = Array.from({ length: kind === 'count' ? 501 : 51 }, (_, i) => {
        const c = template.clone();
        c.setAttribute('id', fixtureId(1000 + i));
        return c;
      });
      const update = change(doc, () => {
        group.delete(0, group.length);
        if (kind === 'count') group.insert(0, copies);
        else {
          for (let i = 0; i < copies.length - 1; i++) {
            const children = new Y.XmlElement('blockGroup');
            children.insert(0, [copies[i + 1]!]);
            copies[i]!.insert(1, [children]);
          }
          group.insert(0, [copies[0]!]);
        }
      });
      expect(() => validateCandidate(base, update)).toThrow(
        kind === 'count' ? 'block count' : 'nesting',
      );
      expect(() => replica.prepare(update)).toThrow(kind === 'count' ? 'block count' : 'nesting');
      replica.abort();
      expect(replica.snapshot()).toEqual(base);
    } finally {
      replica.close();
      doc.destroy();
    }
  },
);
it('counts deleted logical structures and duplicates without rescanning the historical store', async () => {
  const { doc } = await representativeDocument(9);
  const replica = new IncrementalReplica(Y.encodeStateAsUpdate(doc));
  let refused = false;
  try {
    for (let i = 0; i < 25; i++) {
      const base = replica.snapshot();
      const update = change(doc, () => {
        const t = text(doc);
        t.delete(0, t.length);
        t.insert(0, 'x'.repeat(10000));
      });
      try {
        decodeDocument(doc);
      } catch (error) {
        expect(String(error)).toContain('structures');
        expect(() => replica.prepare(update)).toThrow('structures');
        replica.abort();
        expect(replica.snapshot()).toEqual(base);
        refused = true;
        break;
      }
      replica.prepare(update);
      expect(replica.inspect()).toEqual(validateCandidate(base, update).blocks);
      replica.commit();
      replica.prepare(update);
      replica.commit();
      expect(replica.inspect()).toEqual(decodeDocument(doc));
    }
    expect(refused).toBe(true);
  } finally {
    replica.close();
    doc.destroy();
  }
});
