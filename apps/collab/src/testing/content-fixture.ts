import * as Y from 'yjs';
import { representativeDocument } from './fixture.ts';
import { decodeDocument, bounds } from '../codec.ts';

export async function contentFixture() {
  const { doc } = await representativeDocument(500, 1);
  const cards = [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].filter(
    (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
  );
  for (const card of cards) card.setAttribute('biography', '');
  let remaining = bounds.json - 8192 - Buffer.byteLength(JSON.stringify(decodeDocument(doc)));
  for (const card of cards) {
    const n = Math.min(4990, Math.floor(remaining / 4));
    card.setAttribute('biography', '👾'.repeat(n));
    remaining -= n * 4;
  }
  const blocks = decodeDocument(doc),
    snapshot = Y.encodeStateAsUpdate(doc);
  if (blocks.length !== 500 || snapshot.length > bounds.document)
    throw new Error('Invalid content fixture');
  return {
    doc,
    profile: {
      encodedBytes: snapshot.length,
      businessBytes: Buffer.byteLength(JSON.stringify(blocks)),
      blocks: 500,
      characterCards: cards.length,
      historyClients: doc.store.clients.size,
      nestingDepth: 3,
    },
  };
}
