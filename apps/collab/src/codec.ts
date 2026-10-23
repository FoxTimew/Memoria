import * as Y from 'yjs';
import { z } from 'zod';
import { createBlockRegistry } from '@memoria/block-catalog/server';
import type { BlockEnvelope } from '@memoria/blocks-core';

const registry = createBlockRegistry();
export const bounds = {
  update: 4 * 1024 ** 2,
  document: 4 * 1024 ** 2,
  json: 1024 ** 2,
  blocks: 500,
  depth: 50,
  structs: 200_000,
};
const uuid = z.uuid();
function requireShape(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function attributes(node: Y.XmlElement | Y.XmlText, allowed: string[]) {
  const attrs: Record<string, unknown> = node.getAttributes();
  requireShape(
    Object.keys(attrs).every((key) => allowed.includes(key)),
    'Unknown attribute',
  );
  return attrs;
}
function element(node: unknown, name?: string): Y.XmlElement {
  requireShape(
    node instanceof Y.XmlElement && (!name || node.nodeName === name),
    `Expected ${name ?? 'element'}`,
  );
  return node;
}
const common = ['backgroundColor', 'textColor', 'textAlignment'];
function inline(node: Y.XmlElement) {
  const result: unknown[] = [];
  for (const child of node.toArray()) {
    // BlockNote emits hardBreak nodes in addition to text containing newlines.
    if (child instanceof Y.XmlElement && child.nodeName === 'hardBreak') {
      attributes(child, []);
      requireShape(child.length === 0, 'Invalid hard break');
      result.push({ type: 'text', text: '\n', styles: {} });
      continue;
    }
    requireShape(child instanceof Y.XmlText, 'Unknown inline node');
    attributes(child, []);
    for (const delta of child.toDelta()) {
      requireShape(typeof delta.insert === 'string', 'Embedded inline object');
      const styles: Record<string, true> = {};
      let href: unknown;
      for (const [key, value] of Object.entries(delta.attributes ?? {})) {
        requireShape(
          value !== null && typeof value === 'object' && !Array.isArray(value),
          'Invalid mark',
        );
        if (key === 'link') {
          requireShape(Object.keys(value).length === 1 && 'href' in value, 'Invalid link mark');
          href = value.href;
        } else {
          requireShape(
            ['bold', 'italic', 'underline', 'strike', 'code'].includes(key) &&
              Object.keys(value).length === 0,
            'Unknown mark',
          );
          styles[key] = true;
        }
      }
      const span = { type: 'text', text: delta.insert, styles };
      result.push(href === undefined ? span : { type: 'link', href, content: [span] });
    }
  }
  return result;
}

/** Strict raw Yjs codec: no ProseMirror schema coercion/defaulting and no UI dependency. */
export function decodeDocument(doc: Y.Doc): BlockEnvelope[] {
  requireShape(doc.share.size === 1 && doc.share.has('prosemirror'), 'Unknown shared root');
  requireShape(!doc.store.pendingStructs && !doc.store.pendingDs, 'Unresolved Yjs dependencies');
  let structures = 0;
  for (const entries of doc.store.clients.values())
    for (const item of entries) structures += item.length;
  requireShape(structures <= bounds.structs, 'Too many Yjs structures');
  const root = doc.getXmlFragment('prosemirror');
  requireShape(root.length === 1, 'Expected one block group');
  const output: BlockEnvelope[] = [];
  const ids = new Set<string>();
  function walk(rawGroup: unknown, parentId: string | null, depth: number) {
    requireShape(depth <= bounds.depth, 'Maximum nesting depth');
    const group = element(rawGroup, 'blockGroup');
    attributes(group, []);
    requireShape(group.length > 0, 'Empty block group');
    for (const [index, rawContainer] of group.toArray().entries()) {
      requireShape(output.length < bounds.blocks, 'Maximum block count');
      const container = element(rawContainer, 'blockContainer');
      const id = uuid.parse(attributes(container, ['id']).id);
      requireShape(!ids.has(id), 'Duplicate block ID');
      ids.add(id);
      requireShape(container.length === 1 || container.length === 2, 'Invalid block container');
      const node = element(container.get(0));
      let type: string;
      let data: unknown;
      if (node.nodeName === 'gamedevCharacterCard') {
        const props = attributes(node, [
          'schemaVersion',
          'characterId',
          'displayName',
          'archetype',
          'biography',
          'health',
          'attack',
          'tags',
        ]);
        requireShape(props.schemaVersion === 2, 'Unsupported character-card version');
        requireShape(typeof props.tags === 'string', 'Invalid tags');
        const { schemaVersion, tags, ...fields } = props;
        void schemaVersion;
        type = 'gamedev.character-card';
        data = { ...fields, tags: JSON.parse(tags) as unknown };
        requireShape(node.length === 0, 'Unexpected character content');
      } else if (node.nodeName === 'memoriaImage') {
        const props = attributes(node, ['fileId', 'alt', 'caption', 'width']);
        type = 'core.image';
        data = { ...props, fileId: props.fileId === '' ? null : props.fileId };
        requireShape(node.length === 0, 'Unexpected image content');
      } else if (node.nodeName === 'divider') {
        attributes(node, []);
        type = 'core.divider';
        data = {};
        requireShape(node.length === 0, 'Unexpected divider content');
      } else if (node.nodeName === 'codeBlock') {
        const props = attributes(node, ['language']);
        type = 'core.code';
        const spans = inline(node) as { type: string; text: string; styles: object }[];
        requireShape(
          spans.every((s) => s.type === 'text' && Object.keys(s.styles).length === 0),
          'Styled code',
        );
        data = { language: props.language, code: spans.map((s) => s.text).join('') };
      } else {
        const mapping: Record<string, string> = {
          paragraph: 'core.paragraph',
          heading: 'core.heading',
          bulletListItem: 'core.bullet-list-item',
          numberedListItem: 'core.numbered-list-item',
          checkListItem: 'core.todo',
        };
        type = mapping[node.nodeName] ?? '';
        requireShape(type, 'Unknown block type');
        const extra =
          node.nodeName === 'heading'
            ? ['level', 'isToggleable']
            : node.nodeName === 'numberedListItem'
              ? ['start']
              : node.nodeName === 'checkListItem'
                ? ['checked']
                : [];
        const props = attributes(node, [...common, ...extra]);
        requireShape(
          props.backgroundColor === 'default' &&
            props.textColor === 'default' &&
            props.textAlignment === 'left',
          'Unsupported presentation',
        );
        if (node.nodeName === 'heading')
          requireShape(props.isToggleable === false, 'Toggle heading unsupported');
        data = {
          spans: inline(node),
          ...(node.nodeName === 'heading' ? { level: props.level } : {}),
          ...(node.nodeName === 'numberedListItem' ? { start: props.start ?? null } : {}),
          ...(node.nodeName === 'checkListItem' ? { checked: props.checked } : {}),
        };
      }
      const model = registry.get(type);
      output.push({
        id,
        parentId,
        position: `a${String(index).padStart(4, '0')}`,
        type: model.type,
        schemaVersion: model.version,
        content: model.parse(data, model.version),
      });
      if (container.length === 2) walk(container.get(1), id, depth + 1);
    }
  }
  walk(root.get(0), null, 1);
  requireShape(
    Buffer.byteLength(JSON.stringify(output)) <= bounds.json,
    'Maximum business JSON size',
  );
  return output;
}

export function validateCandidate(base: Uint8Array, update: Uint8Array) {
  requireShape(update.byteLength <= bounds.update, 'Maximum update size');
  requireShape(base.byteLength <= bounds.document, 'Maximum base size');
  const candidate = new Y.Doc();
  try {
    candidate.getXmlFragment('prosemirror');
    Y.applyUpdate(candidate, base);
    Y.applyUpdate(candidate, update);
    const blocks = decodeDocument(candidate);
    const snapshot = Y.encodeStateAsUpdate(candidate);
    requireShape(snapshot.byteLength <= bounds.document, 'Maximum document size');
    return { snapshot, blocks };
  } finally {
    candidate.destroy();
  }
}
