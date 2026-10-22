import { describe, expect, it } from 'vitest';
import { createOpenApiDocument } from './openapi.ts';

describe('generated OpenAPI concurrency contract', () => {
  it('requires idempotency for every POST and declares conditional block writes', () => {
    const spec = createOpenApiDocument();
    for (const item of Object.values(spec.paths ?? {})) {
      if (!item?.post) continue;
      expect(item.post.parameters).toContainEqual(
        expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: true }),
      );
    }
    const blocks = spec.paths?.['/v1/workspaces/{workspaceId}/pages/{pageId}/blocks']?.post;
    expect(blocks?.parameters).toContainEqual(
      expect.objectContaining({ name: 'If-Match', required: true }),
    );
    expect(blocks?.responses).toHaveProperty('412');
    expect(blocks?.responses).toHaveProperty('428');
  });
});
