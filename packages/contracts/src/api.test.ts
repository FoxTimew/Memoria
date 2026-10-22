import { describe, expect, it } from 'vitest';
import { blockBatchSchema, expectedPageVersion, pageETag, propertyValueSchema } from './api.ts';

describe('public API contracts', () => {
  const id = '596208b2-4a76-4c35-bb14-b27731fc8417';
  it('accepts only the strong ETag for the target page', () => {
    expect(expectedPageVersion(pageETag(id, 42), id)).toBe(42);
    for (const value of [
      '*',
      `W/${pageETag(id, 42)}`,
      '"page-other-v42"',
      `${pageETag(id, 42)}, ${pageETag(id, 43)}`,
    ]) {
      expect(() => expectedPageVersion(value, id)).toThrow();
    }
  });
  it('keeps numbers exact and rejects executable URLs', () => {
    expect(
      propertyValueSchema.parse({ type: 'number', value: '12345678901234567890.12345678' }),
    ).toBeDefined();
    expect(propertyValueSchema.safeParse({ type: 'number', value: 0.1 }).success).toBe(false);
    expect(
      propertyValueSchema.safeParse({ type: 'url', value: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });
  it('uses relative placement rather than trusting client-generated ranks', () => {
    expect(
      blockBatchSchema.safeParse({
        operations: [{ op: 'move', id, parentId: null, afterId: null, position: 'a0' }],
      }).success,
    ).toBe(false);
  });
});
