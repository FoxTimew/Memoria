import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { BlockBatch } from '@memoria/contracts';
import { createBlockRegistry } from '@memoria/block-catalog/server';
import { decodeDocument } from '../codec.ts';

const registry = createBlockRegistry();
const names: Record<string, string> = {
  'core.paragraph': 'paragraph',
  'core.heading': 'heading',
  'core.bullet-list-item': 'bulletListItem',
  'core.numbered-list-item': 'numberedListItem',
  'core.todo': 'checkListItem',
  'core.code': 'codeBlock',
  'core.image': 'memoriaImage',
  'core.divider': 'divider',
  'gamedev.character-card': 'gamedevCharacterCard',
};
function contentNode(type: string, version: number, raw: Record<string, unknown>) {
  const data = registry.get(type).parse(raw, version) as Record<string, unknown>;
  const node = new Y.XmlElement(names[type]!);
  const set = (key: string, value: unknown) => node.setAttribute(key, value as string);
  if (type === 'gamedev.character-card') {
    set('schemaVersion', 2);
    for (const [key, value] of Object.entries(data))
      set(key, key === 'tags' ? JSON.stringify(value) : value);
  } else if (type === 'core.image') {
    for (const [key, value] of Object.entries(data))
      set(key, key === 'fileId' ? (value ?? '') : value);
  } else if (type !== 'core.divider') {
    const text = new Y.XmlText();
    node.insert(0, [text]);
    if (type === 'core.code') {
      set('language', data.language);
      text.insert(0, data.code as string);
    } else {
      set('backgroundColor', 'default');
      set('textColor', 'default');
      set('textAlignment', 'left');
      if (type === 'core.heading') {
        set('level', data.level);
        set('isToggleable', false);
      }
      if (type === 'core.todo') set('checked', data.checked);
      if (type === 'core.numbered-list-item' && data.start !== null) set('start', data.start);
      type Span = {
        type: string;
        text?: string;
        styles?: Record<string, boolean>;
        href?: string;
        content?: Span[];
      };
      let offset = 0;
      const add = (span: Span, href?: string) => {
        if (span.type === 'link') {
          for (const child of span.content!) add(child, span.href);
          return;
        }
        const marks: Record<string, object> = {};
        for (const [key, value] of Object.entries(span.styles ?? {})) if (value) marks[key] = {};
        if (href) marks.link = { href };
        text.insert(offset, span.text!, marks);
        offset += span.text!.length;
      };
      for (const span of data.spans as Span[]) add(span);
    }
  }
  return node;
}
export function emptyDocument() {
  const doc = new Y.Doc(),
    group = new Y.XmlElement('blockGroup'),
    block = new Y.XmlElement('blockContainer');
  block.setAttribute('id', randomUUID());
  block.insert(0, [contentNode('core.paragraph', 1, { spans: [] })]);
  group.insert(0, [block]);
  doc.getXmlFragment('prosemirror').insert(0, [group]);
  return doc;
}
/** Run on an isolated command candidate. Existing fields keep their Yjs identities. */
export function applyCommands(doc: Y.Doc, operations: BlockBatch['operations']) {
  const root = doc.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
  function find(id: string, group = root): Y.XmlElement | undefined {
    for (const node of group.toArray() as Y.XmlElement[]) {
      if (node.getAttribute('id') === id) return node;
      if (node.length === 2) {
        const found = find(id, node.get(1) as Y.XmlElement);
        if (found) return found;
      }
    }
  }
  function detach(node: Y.XmlElement) {
    const parent = node.parent as Y.XmlElement;
    parent.delete(parent.toArray().indexOf(node), 1);
    if (parent !== root && !parent.length) (parent.parent as Y.XmlElement).delete(1, 1);
  }
  function place(node: Y.XmlElement, parentId: string | null, afterId: string | null) {
    let group = root;
    if (parentId) {
      const parent = find(parentId);
      if (!parent) throw new Error('Unknown parent');
      if (parent.length === 1) parent.insert(1, [new Y.XmlElement('blockGroup')]);
      group = parent.get(1) as Y.XmlElement;
    }
    const index =
      afterId === null
        ? -1
        : (group.toArray() as Y.XmlElement[]).findIndex((n) => n.getAttribute('id') === afterId);
    if (afterId !== null && index < 0) throw new Error('Unknown previous sibling');
    group.insert(index + 1, [node]);
  }
  for (const op of operations) {
    const node = find(op.id);
    if (op.op === 'insert') {
      if (node) throw new Error('Duplicate block ID');
      const inserted = new Y.XmlElement('blockContainer');
      inserted.setAttribute('id', op.id);
      inserted.insert(0, [contentNode(op.type, op.schemaVersion, op.content)]);
      place(inserted, op.parentId, op.afterId);
    } else {
      if (!node) throw new Error('Unknown block');
      if (op.op === 'update') {
        const previous = decodeDocument(doc).find((b) => b.id === op.id)!;
        const fresh = contentNode(op.type ?? previous.type, op.schemaVersion, op.content);
        const current = node.get(0) as Y.XmlElement;
        if (fresh.nodeName === 'gamedevCharacterCard' && current.nodeName === fresh.nodeName) {
          // Compare normalized model values, because preliminary Y.XmlElement reads are undefined.
          const parsed = registry.get(previous.type).parse(op.content, op.schemaVersion) as Record<
            string,
            unknown
          >;
          for (const [key, value] of Object.entries(parsed)) {
            const encoded = key === 'tags' ? JSON.stringify(value) : value;
            if (current.getAttribute(key) !== encoded) current.setAttribute(key, encoded as string);
          }
        } else {
          node.delete(0, 1);
          node.insert(0, [fresh]);
        }
      } else if (op.op === 'archive') detach(node);
      else if (op.op === 'move') {
        let ancestor = op.parentId ? find(op.parentId) : undefined;
        while (ancestor) {
          if (ancestor === node) throw new Error('Block cycle');
          ancestor = ancestor.parent?.parent as Y.XmlElement | undefined;
        }
        const clone = node.clone();
        detach(node);
        place(clone, op.parentId, op.afterId);
      } else throw new Error('Restore belongs to the editor undo history');
    }
  }
  decodeDocument(doc);
}
