import type { EditorProps } from '@memoria/blocks-core';
import { characterCardSchema } from './model.ts';
import type { CharacterCard } from './model.ts';

// BlockNote props accept primitives; this string is only an editor transport.
// The persistence/API representation is always the validated JSON object.
export function toEditorProps(data: CharacterCard): { data: string } {
  return { data: JSON.stringify(characterCardSchema.parse(data)) };
}
export function fromEditorProps(props: EditorProps): CharacterCard {
  if (typeof props.data !== 'string') throw new Error('Missing character-card editor data');
  const parsed: unknown = JSON.parse(props.data);
  return characterCardSchema.parse(parsed);
}
