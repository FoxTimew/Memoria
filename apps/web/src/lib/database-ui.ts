import type { DatabaseQuery } from '@memoria/contracts';
import { ContentError, contentRequest } from './content-api.ts';

export const kinds = {
  text: 'Texte',
  number: 'Nombre',
  select: 'Choix',
  multi_select: 'Choix multiples',
  date: 'Date',
  checkbox: 'Case à cocher',
  person: 'Personnes',
  relation: 'Relation',
  url: 'Lien URL',
} as const;
export type Kind = keyof typeof kinds;
export type Property = {
  id: string;
  name: string;
  kind: Kind;
  config: { mode?: 'date' | 'instant' };
  relation_target_database_id: string | null;
};
export type Option = {
  id: string;
  property_id: string;
  label: string;
  color: string | null;
  deleted_at: string | null;
};
export type Choice = { id: string; label?: string; name?: string; title?: string };
export type References = { items: Choice[]; hasHidden: boolean };
export type CellValue =
  | string
  | boolean
  | null
  | string[]
  | References
  | { start: string; end: string | null; timeZone?: string };
export type Cell = { version: string; schemaVersion: string; value: CellValue };
export type BaseSummary = { id: string; page_id: string; title: string; level: 'read' | 'edit' };
export type Base = {
  id: string;
  page_id: string;
  schema_version: string;
  level: 'read' | 'edit';
  canManageSchema: boolean;
  properties: Property[];
  options: Option[];
  view: DatabaseQuery;
  viewUnavailable: boolean;
};
export type Row = { id: string; title: string; version: string | number };
type Address = { row_page_id: string; property_id: string };
export type Table = {
  rows: Row[];
  schemaVersion: string;
  hasMore: boolean;
  cursor: string | null;
  scalar: (Address & {
    text_value: string | null;
    number_value: string | null;
    boolean_value: boolean | null;
    option_id: string | null;
    date_start: string | null;
    date_end: string | null;
    date_time_start: string | null;
    date_time_end: string | null;
    time_zone: string | null;
  })[];
  multi: (Address & { items: string[] })[];
  person: (Address & References)[];
  relation: (Address & References)[];
};
export async function databaseRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  try {
    return (await contentRequest(path, method, body)) as T;
  } catch (e) {
    if (e instanceof ContentError) {
      const messages: Record<string, string> = {
        INVALID_CELL: 'Cette valeur ne correspond pas au type de la colonne. Vérifiez son format.',
        VALUE_LIMIT: 'La valeur dépasse la limite configurée pour cette colonne.',
        REFERENCE_UNAVAILABLE:
          'Un des choix n’est plus accessible. Actualisez les valeurs proposées.',
        SCHEMA_VERSION_CONFLICT:
          'Les colonnes ont changé. Actualisez le tableau avant de réessayer.',
        CELL_VERSION_CONFLICT: 'Cette cellule a changé ailleurs. Votre saisie est conservée.',
        TABLE_CURSOR_STALE: 'Le tableau ou vos droits ont changé. Revenez à la première page.',
        INVALID_DATABASE_INPUT: 'Vérifiez les valeurs saisies et les limites de la base.',
        INVALID_DATABASE_QUERY: 'Ce filtre ne correspond pas au type de la colonne.',
        DATABASE_CAPACITY_REACHED: 'La limite configurée pour cette base est atteinte.',
        TYPE_CHANGE_REQUIRES_EMPTY_PROPERTY: 'Videz cette colonne avant de changer son type.',
      };
      if (messages[e.code]) throw new ContentError(e.status, e.code, messages[e.code]!);
    }
    throw e;
  }
}
export function tableValue(table: Table, row: string, p: Property): CellValue {
  const at = (v: Address) => v.row_page_id === row && v.property_id === p.id;
  if (p.kind === 'person' || p.kind === 'relation')
    return table[p.kind].find(at) ?? { items: [], hasHidden: false };
  if (p.kind === 'multi_select') return table.multi.find(at)?.items ?? [];
  const v = table.scalar.find(at);
  if (!v) return null;
  switch (p.kind) {
    case 'text':
    case 'url':
      return v.text_value;
    case 'number':
      return v.number_value;
    case 'checkbox':
      return v.boolean_value;
    case 'select':
      return v.option_id;
    case 'date':
      return v.date_start
        ? { start: v.date_start, end: v.date_end }
        : v.date_time_start
          ? {
              start: new Date(v.date_time_start).toISOString(),
              end: v.date_time_end ? new Date(v.date_time_end).toISOString() : null,
              timeZone: v.time_zone ?? 'UTC',
            }
          : null;
  }
}
export function choiceLabel(c: Choice) {
  return (c.label ?? c.name ?? c.title) || 'Sans titre';
}
export function displayValue(value: CellValue, p: Property, options: Option[] = []): string {
  if (value === null) return 'Vide';
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  const option = (id: string) => {
    const o = options.find((o) => o.id === id);
    return o ? o.label + (o.deleted_at ? ' (retiré)' : '') : 'Choix retiré';
  };
  if (typeof value === 'string') return p.kind === 'select' ? option(value) : value || 'Vide';
  if (Array.isArray(value)) return value.map(option).join(', ') || 'Vide';
  if ('items' in value)
    return (
      [
        ...value.items.map(choiceLabel),
        ...(value.hasHidden ? ['Certaines valeurs ne sont pas accessibles'] : []),
      ].join(' · ') || 'Vide'
    );
  return `${value.start}${value.end ? ' → ' + value.end : ''}`;
}
/** Reference edits are deltas over the visible selection, never replacement of hidden links. */
export function referenceDelta(before: CellValue, selected: string[]) {
  const old =
    before && typeof before === 'object' && 'items' in before ? before.items.map((v) => v.id) : [];
  return {
    add: selected.filter((id) => !old.includes(id)),
    remove: old.filter((id) => !selected.includes(id)),
  };
}
export function operators(kind: Kind): DatabaseQuery['filters'][number]['op'][] {
  const empty = ['empty', 'notEmpty'] as const;
  if (['person', 'relation', 'multi_select'].includes(kind)) return ['any', ...empty];
  if (kind === 'select') return ['in', ...empty];
  if (kind === 'checkbox') return ['eq', ...empty];
  if (kind === 'number') return ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between', ...empty];
  if (kind === 'date') return ['eq', 'lt', 'gt', 'between', ...empty];
  return ['eq', 'contains', 'startsWith', ...empty];
}
