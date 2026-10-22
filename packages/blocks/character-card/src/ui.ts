'use client';

import type { BlockUi } from '@memoria/blocks-ui';
import { characterCardModel } from './model.ts';
import type { CharacterCard } from './model.ts';

export const characterCardUi = {
  model: characterCardModel,
  menu: {
    icon: 'contact-round',
    label: 'Character card',
    category: 'Game design',
    keywords: ['character', 'npc', 'stats'],
  },
  loadEditor: () => import('./editor.tsx'),
  loadReadonly: () => import('./readonly.tsx'),
} satisfies BlockUi<CharacterCard>;

export { fromEditorProps, toEditorProps } from './adapter.ts';
