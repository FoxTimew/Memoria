import type { DraftBlock } from '@memoria/block-catalog/client';
// Compatibility with the old IndexedDB store until its removal in 3c; no writer uses it in 3b.
export type Draft = { title: string; blocks: DraftBlock[] };
export type DraftSnapshot = { version: number; base: Draft; draft: Draft; history: DraftBlock[] };
