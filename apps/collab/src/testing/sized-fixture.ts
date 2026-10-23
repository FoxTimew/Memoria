import * as Y from 'yjs';
import { representativeDocument } from './fixture.ts';
import { decodeDocument } from '../codec.ts';

/** Adversarial retained history, using real edits and default GC. Historical clients
 * are spread across card fields so fixture generation is not one quadratic chain.
 * This is a metadata stress profile, not a claim about typical history growth. */
export async function historyFixture(targetBytes: number) {
  const source = (await representativeDocument(300, 1)).doc;
  const cards = [...source.getXmlFragment('prosemirror').createTreeWalker(() => true)].filter(
    (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
  );
  const root = new Y.Doc();
  root.getXmlFragment('prosemirror').insert(0, [new Y.XmlElement('blockGroup')]);
  const rootBytes = Y.encodeStateAsUpdate(root);
  const clientIds = new Set<number>([root.clientID, source.clientID]);
  function fresh() {
    let doc = new Y.Doc();
    while (clientIds.has(doc.clientID)) {
      doc.destroy();
      doc = new Y.Doc();
    }
    clientIds.add(doc.clientID);
    return doc;
  }
  const seeds = cards.map((card) => {
    const doc = fresh();
    Y.applyUpdate(doc, rootBytes);
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', (card.parent as Y.XmlElement).getAttribute('id')!);
    container.insert(0, [card.clone()]);
    (doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).insert(0, [container]);
    const bytes = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return bytes;
  });
  for (const bytes of seeds) Y.applyUpdate(root, bytes);
  function withoutCards(container: Y.XmlElement): Y.XmlElement[] {
    const content = container.get(0) as Y.XmlElement;
    const children =
      container.length > 1
        ? (container.get(1) as Y.XmlElement)
            .toArray()
            .flatMap((c) => withoutCards(c as Y.XmlElement))
        : [];
    if (content.nodeName === 'gamedevCharacterCard') return children;
    const copy = new Y.XmlElement('blockContainer');
    copy.setAttribute('id', container.getAttribute('id')!);
    copy.insert(0, [content.clone()]);
    if (children.length) {
      const group = new Y.XmlElement('blockGroup');
      group.insert(0, children);
      copy.insert(1, [group]);
    }
    return [copy];
  }
  const group = root.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
  group.insert(
    group.length,
    (source.getXmlFragment('prosemirror').get(0) as Y.XmlElement)
      .toArray()
      .flatMap((c) => withoutCards(c as Y.XmlElement)),
  );
  const base = Y.encodeStateAsUpdate(root);
  root.destroy();
  source.destroy();
  const updates: Uint8Array[] = [];
  function make(count: number) {
    while (updates.length < count) {
      const doc = fresh();
      Y.applyUpdate(doc, seeds[updates.length % seeds.length]!);
      const card = (
        (doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlElement
      ).get(0) as Y.XmlElement;
      let update!: Uint8Array;
      doc.on('update', (value: Uint8Array) => {
        update = value;
      });
      card.setAttribute(
        Math.floor(updates.length / seeds.length) % 2 ? 'health' : 'attack',
        77 as unknown as string,
      );
      updates.push(update);
      doc.destroy();
    }
    const doc = new Y.Doc();
    doc.getXmlFragment('prosemirror');
    let merged = updates.slice(0, count);
    while (merged.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < merged.length; i += 64)
        next.push(Y.mergeUpdates(merged.slice(i, i + 64)));
      merged = next;
    }
    Y.applyUpdate(doc, base);
    Y.applyUpdate(doc, merged[0]!);
    return doc;
  }
  let count = 1000,
    doc = make(count),
    size = Y.encodeStateAsUpdate(doc).length;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (size <= targetBytes && targetBytes - size < 8000) break;
    count = Math.max(
      1,
      Math.floor((count * (targetBytes - base.length - 2000)) / (size - base.length)),
    );
    doc.destroy();
    doc = make(count);
    size = Y.encodeStateAsUpdate(doc).length;
  }
  if (size > targetBytes || targetBytes - size >= 8000)
    throw new Error('Unable to size history fixture');
  const blocks = decodeDocument(doc);
  const reloaded = new Y.Doc();
  reloaded.getXmlFragment('prosemirror');
  Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
  const reencoded = Y.encodeStateAsUpdate(reloaded).length;
  reloaded.destroy();
  if (reencoded !== size) throw new Error('GC shrank measured fixture');
  return {
    doc,
    profile: {
      targetBytes,
      encodedBytes: size,
      historyClients: count,
      gc: doc.gc,
      blocks: blocks.length,
      businessBytes: Buffer.byteLength(JSON.stringify(blocks)),
      logicalElements: [...doc.store.clients.values()].reduce(
        (total, items) => total + items.reduce((n, item) => n + item.length, 0),
        0,
      ),
      structRecords: [...doc.store.clients.values()].reduce((n, items) => n + items.length, 0),
      reencodedBytes: reencoded,
    },
  };
}
