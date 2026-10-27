import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
/** Server-only initial body. Shared by the journal and transactional row creation. */
export function emptyDocument() {
  const doc = new Y.Doc(),
    group = new Y.XmlElement('blockGroup'),
    block = new Y.XmlElement('blockContainer'),
    paragraph = new Y.XmlElement('paragraph');
  block.setAttribute('id', randomUUID());
  for (const [key, value] of Object.entries({
    backgroundColor: 'default',
    textColor: 'default',
    textAlignment: 'left',
  }))
    paragraph.setAttribute(key, value);
  paragraph.insert(0, [new Y.XmlText()]);
  block.insert(0, [paragraph]);
  group.insert(0, [block]);
  doc.getXmlFragment('prosemirror').insert(0, [group]);
  return doc;
}
export function initialDocument() {
  const doc = emptyDocument();
  try {
    const group = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
    const id = (group.get(0) as Y.XmlElement).getAttribute('id');
    // The codec equivalence test pins this initial envelope as well as the Yjs structure.
    const envelope = [
      {
        id,
        parentId: null,
        position: 'a0000',
        type: 'core.paragraph',
        schemaVersion: 1,
        content: { spans: [] },
      },
    ];
    return {
      snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)),
      businessBytes: Buffer.byteLength(JSON.stringify(envelope)),
    };
  } finally {
    doc.destroy();
  }
}
