import type { BlockDefinition } from '@memoria/blocks-core';
import { characterCardSchema, characterCardToPlainText, migrateCharacterCard } from './model.ts';
import type { CharacterCard } from './model.ts';

export const characterCard = {
  type: 'gamedev.character-card',
  version: 2,
  schema: characterCardSchema,
  menu: {
    icon: 'contact-round',
    label: 'Character card',
    category: 'Game design',
    keywords: ['character', 'npc', 'stats'],
  },
  createDefault: () => ({
    characterId: globalThis.crypto.randomUUID(),
    displayName: 'Unnamed character',
    archetype: 'npc',
    biography: '',
    health: 100,
    attack: 10,
    tags: [],
  }),
  migrate: migrateCharacterCard,
  toPlainText: characterCardToPlainText,
  loadEditor: () => import('./editor.tsx'),
  loadReadonly: () => import('./readonly.tsx'),
} satisfies BlockDefinition<CharacterCard>;

export { characterCardSchema, migrateCharacterCard, characterCardToPlainText } from './model.ts';
export type { CharacterCard } from './model.ts';
