import { describe, it, expect } from 'vitest';
import { accessReturnPath } from './access-flow.ts';
describe('security return paths', () => {
  it('never accepts external, encoded, prefixed or query-bearing redirect destinations', () => {
    for (const value of [
      'https://evil.test',
      '//evil.test',
      'javascript:alert(1)',
      '/\\evil.test',
      '/%2f%2fevil.test',
      '/invitation?next=https://evil.test',
      '/invitation#x',
      '/workspaces/../acces',
      '/workspaces/00000000-0000-0000-0000-000000000000/acces/elsewhere',
    ])
      expect(accessReturnPath(value)).toBeNull();
    expect(accessReturnPath('/invitation')).toBe('/invitation');
    expect(accessReturnPath('/workspaces/00000000-0000-0000-0000-000000000000/acces')).toBeTruthy();
  });
});
