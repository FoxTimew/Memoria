import type { BlockData, BlockModel } from '@memoria/blocks-core';
export function ReadonlyBlock({ model, data }: { model: BlockModel<BlockData>; data: BlockData }) {
  return (
    <div style={{ whiteSpace: 'pre-wrap' }}>{model.toPlainText(model.schema.parse(data))}</div>
  );
}
