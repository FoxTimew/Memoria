import type { BlockSpecs } from '@blocknote/core';
import type { ComponentType } from 'react';
import type { z } from 'zod';

export type JsonValue =
  null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type BlockData = { [key: string]: JsonValue };
export type BlockType = `${string}.${string}`;
export type EditorProps = Record<string, string | number | boolean>;

export interface BlockEditorModule<Data extends BlockData> {
  readonly editorType: string;
  readonly spec: BlockSpecs[string];
  toEditorProps(data: Data): EditorProps;
  fromEditorProps(props: EditorProps): Data;
}

export interface BlockDefinition<Data extends BlockData> {
  readonly type: BlockType;
  readonly version: number;
  readonly schema: z.ZodType<Data>;
  readonly menu: {
    readonly icon: string;
    readonly label: string;
    readonly category: string;
    readonly keywords: readonly string[];
  };
  createDefault(): Data;
  /** Pure migration. Reject unsupported future versions; never modify the input. */
  migrate(data: unknown, fromVersion: number): Data;
  toPlainText(data: Data): string;
  loadEditor(): Promise<BlockEditorModule<Data>>;
  loadReadonly(): Promise<{ default: ComponentType<{ data: Data }> }>;
}
