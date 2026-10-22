import { z } from 'zod';
import type { BlockData, BlockModel, BlockType } from './definition.ts';

export const blockTypeSchema = z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
export const blockEnvelopeSchema = z.strictObject({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  position: z
    .string()
    .regex(/^[0-9A-Za-z]+$/)
    .max(128),
  type: blockTypeSchema,
  schemaVersion: z.int().positive(),
  content: z.record(z.string(), z.json()),
});
export type BlockEnvelope = z.infer<typeof blockEnvelopeSchema>;

interface RegisteredBlock {
  readonly type: BlockType;
  readonly version: number;
  parse(data: unknown, fromVersion: number): BlockData;
  toPlainText(data: unknown): string;
}

export class BlockRegistry {
  readonly #definitions = new Map<string, RegisteredBlock>();

  register<Data extends BlockData>(definition: BlockModel<Data>): this {
    blockTypeSchema.parse(definition.type);
    z.int().positive().parse(definition.version);
    if (this.#definitions.has(definition.type))
      throw new Error(`Duplicate block type: ${definition.type}`);
    this.#definitions.set(definition.type, {
      type: definition.type,
      version: definition.version,
      parse: (data, fromVersion) => {
        if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion > definition.version)
          throw new Error(`Unsupported version ${fromVersion} for ${definition.type}`);
        return definition.schema.parse(
          fromVersion === definition.version ? data : definition.migrate(data, fromVersion),
        );
      },
      toPlainText: (data) => definition.toPlainText(definition.schema.parse(data)),
    });
    return this;
  }

  get(type: string): RegisteredBlock {
    const definition = this.#definitions.get(type);
    if (!definition) throw new Error(`Unknown block type: ${type}`);
    return definition;
  }

  validateWrite(input: unknown): BlockEnvelope {
    const envelope = blockEnvelopeSchema.parse(input);
    const definition = this.get(envelope.type);
    return {
      ...envelope,
      content: definition.parse(envelope.content, envelope.schemaVersion),
      schemaVersion: definition.version,
    };
  }

  toPlainText(input: unknown): string {
    const block = this.validateWrite(input);
    return this.get(block.type).toPlainText(block.content);
  }
}
