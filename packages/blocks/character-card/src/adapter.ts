import type { EditorProps } from '@memoria/blocks-ui';
import { characterCardSchema } from './model.ts';
import type { CharacterCard } from './model.ts';

export const characterCardProps = {
  schemaVersion: { default: 2 },
  characterId: { default: '' },
  displayName: { default: '' },
  archetype: { default: 'npc' },
  biography: { default: '' },
  health: { default: 100 },
  attack: { default: 10 },
  tags: { default: '[]' },
} as const;

// Each field has its own Yjs attribute. Only tags remain an atomic JSON array.
export function toEditorProps(data: CharacterCard) {
  const parsed = characterCardSchema.parse(data);
  return { ...parsed, schemaVersion: 2, tags: JSON.stringify(parsed.tags) };
}
export function fromEditorProps(props: EditorProps): CharacterCard {
  if (props.schemaVersion !== 2 || typeof props.tags !== 'string')
    throw new Error('Invalid character-card props');
  const { schemaVersion, tags, ...fields } = props;
  void schemaVersion;
  return characterCardSchema.parse({ ...fields, tags: JSON.parse(tags) as unknown });
}
export function changedEditorProps(value: CharacterCard, patch: Partial<CharacterCard>) {
  const encoded = toEditorProps({ ...value, ...patch });
  return Object.fromEntries(
    Object.keys(patch).map((key) => [key, encoded[key as keyof CharacterCard]]),
  );
}
