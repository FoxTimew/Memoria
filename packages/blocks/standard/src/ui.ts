'use client';
import type { BlockData } from '@memoria/blocks-core';
import type { BlockUi } from '@memoria/blocks-ui';
import { standardModels } from './model.ts';

const labels = [
  'Paragraphe',
  'Titre',
  'Liste à puces',
  'Liste numérotée',
  'Tâche',
  'Code',
  'Image',
  'Séparateur',
  'Fichier',
];
export async function loadStandardSpecs() {
  return (await import('./editor.tsx')).standardSpecs;
}
export const standardUis: BlockUi<BlockData>[] = standardModels.map((model, index) => ({
  model,
  menu: { icon: 'text', label: labels[index]!, category: 'Contenu', keywords: [model.type] },
  loadEditor: async () => (await import('./editor.tsx')).standardAdapters[index]!,
  loadReadonly: async () => {
    const { ReadonlyBlock } = await import('./readonly.tsx');
    return { default: ({ data }) => ReadonlyBlock({ model, data }) };
  },
}));
