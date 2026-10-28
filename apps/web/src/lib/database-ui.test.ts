import { describe, expect, it } from 'vitest';
import { displayValue, referenceDelta, operators, tableValue } from './database-ui.ts';
import type { Property, Table } from './database-ui.ts';
import { accessReturnPath } from './access-flow.ts';
import { searchResultsSchema } from '@memoria/contracts';
const p = (kind: Property['kind']): Property => ({
  id: 'p',
  name: 'Test',
  kind,
  config: {},
  relation_target_database_id: null,
});
describe('table UI boundaries', () => {
  it('keeps zero, false and empty distinct', () => {
    expect(displayValue('0', p('number'))).toBe('0');
    expect(displayValue(false, p('checkbox'))).toBe('Non');
    expect(displayValue(null, p('checkbox'))).toBe('Vide');
  });
  it('shows a single neutral hidden-reference message without count or identifier', () => {
    expect(
      displayValue({ items: [{ id: 'a', title: 'Visible' }], hasHidden: true }, p('relation')),
    ).toBe('Visible · Certaines valeurs ne sont pas accessibles');
  });
  it('sends only visible reference deltas, retaining hidden and concurrently added links', () => {
    expect(
      referenceDelta({ items: [{ id: 'a' }, { id: 'b' }], hasHidden: true }, ['b', 'c']),
    ).toEqual({ add: ['c'], remove: ['a'] });
    expect(referenceDelta({ items: [], hasHidden: true }, [])).toEqual({ add: [], remove: [] });
  });
  it('decodes absent sets and dates without manufacturing a value', () => {
    const table = { scalar: [], multi: [], person: [], relation: [] } as unknown as Table;
    expect(tableValue(table, 'r', p('multi_select'))).toEqual([]);
    expect(tableValue(table, 'r', p('relation'))).toEqual({ items: [], hasHidden: false });
    expect(tableValue(table, 'r', p('date'))).toBeNull();
  });
  it('offers only the accepted operators for dates, references, text and checkbox', () => {
    expect(operators('date')).toEqual(['eq', 'lt', 'gt', 'between', 'empty', 'notEmpty']);
    expect(operators('relation')).toEqual(['any', 'empty', 'notEmpty']);
    expect(operators('text')).toContain('contains');
    expect(operators('checkbox')).not.toContain('ne');
  });
  it('permits only a fixed local database return path after MFA', () => {
    const path =
      '/workspaces/11111111-1111-4111-8111-111111111111/databases/22222222-2222-4222-8222-222222222222';
    expect(accessReturnPath(path)).toBe(path);
    expect(accessReturnPath('https://attacker.test' + path)).toBeNull();
    expect(accessReturnPath(path + '?next=//attacker.test')).toBeNull();
  });
  it('accepts a row search result with its native database destination', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(
      searchResultsSchema.parse([{ id, title: 'Tâche', excerpt: 'Texte', databaseId: id }])[0]
        ?.databaseId,
    ).toBe(id);
  });
});
