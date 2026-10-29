import type { BlockSpecs } from '@blocknote/core';
import type { ComponentType } from 'react';
import type { BlockData, BlockModel } from '@memoria/blocks-core';
export { FileBlockContext, FileBlockView } from './file-view.tsx';
export type { FileBlockProps } from './file-view.tsx';

export type EditorProps = Record<string, string | number | boolean>;

/** BlockNote-specific transport; never part of the persisted model. */
export interface BlockEditorModule<Data extends BlockData> {
  readonly editorType: string;
  readonly spec: BlockSpecs[string];
  toEditorProps(data: Data): EditorProps;
  fromEditorProps(props: EditorProps): Data;
  /** Inline/plain content lives outside primitive BlockNote props. */
  toEditorContent?(data: Data): unknown;
  fromEditorContent?(props: EditorProps, content: unknown): Data;
}

export interface BlockUi<Data extends BlockData> {
  readonly model: BlockModel<Data>;
  readonly menu: {
    readonly icon: string;
    readonly label: string;
    readonly category: string;
    readonly keywords: readonly string[];
  };
  loadEditor(): Promise<BlockEditorModule<Data>>;
  loadReadonly(): Promise<{ default: ComponentType<{ data: Data }> }>;
}
