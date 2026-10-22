import type { z } from 'zod';

export type JsonValue =
  null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type BlockData = { [key: string]: JsonValue };
export type BlockType = `${string}.${string}`;
export interface BlockModel<Data extends BlockData> {
  readonly type: BlockType;
  readonly version: number;
  readonly schema: z.ZodType<Data>;
  createDefault(): Data;
  /** Pure migration. Reject unsupported future versions; never modify the input. */
  migrate(data: unknown, fromVersion: number): Data;
  toPlainText(data: Data): string;
}
