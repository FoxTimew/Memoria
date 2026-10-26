import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { member, organization } from './auth.ts';
import { auditReferences, businessFields, rank, time } from './common.ts';
import type { JsonObject } from './common.ts';
import { pages, pageReference } from './content.ts';

export const propertyKind = pgEnum('property_kind', [
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'checkbox',
  'person',
  'relation',
  'url',
]);

export const databases = pgTable(
  'databases',
  {
    ...businessFields(),
    pageId: uuid('page_id').notNull(),
    schemaVersion: bigint('schema_version', { mode: 'bigint' })
      .default(sql`1`)
      .notNull(),
  },
  (t) => [
    unique('databases_workspace_id_uq').on(t.workspaceId, t.id),
    unique('databases_page_uq').on(t.workspaceId, t.pageId),
    pageReference(t.workspaceId, t.pageId),
    ...auditReferences(t),
  ],
);

export const databaseRows = pgTable(
  'database_rows',
  {
    ...businessFields(),
    databaseId: uuid('database_id').notNull(),
    pageId: uuid('page_id').notNull(),
    lifecycleVersion: bigint('lifecycle_version', { mode: 'bigint' })
      .default(sql`1`)
      .notNull(),
  },
  (t) => [
    unique('rows_page_uq').on(t.workspaceId, t.pageId),
    unique('rows_database_page_uq').on(t.workspaceId, t.databaseId, t.pageId),
    foreignKey({
      columns: [t.workspaceId, t.databaseId],
      foreignColumns: [databases.workspaceId, databases.id],
    }).onDelete('cascade'),
    pageReference(t.workspaceId, t.pageId),
    ...auditReferences(t),
  ],
);

export const databaseProperties = pgTable(
  'database_properties',
  {
    ...businessFields(),
    databaseId: uuid('database_id').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    kind: propertyKind('kind').notNull(),
    position: rank('position').notNull(),
    config: jsonb('config').$type<JsonObject>().default({}).notNull(),
    relationTargetDatabaseId: uuid('relation_target_database_id'),
  },
  (t) => [
    unique('properties_workspace_id_uq').on(t.workspaceId, t.id),
    unique('properties_database_id_uq').on(t.workspaceId, t.databaseId, t.id),
    unique('properties_typed_uq').on(t.workspaceId, t.databaseId, t.id, t.kind),
    unique('properties_relation_target_uq').on(
      t.workspaceId,
      t.databaseId,
      t.id,
      t.relationTargetDatabaseId,
    ),
    uniqueIndex('properties_live_key_uq')
      .on(t.workspaceId, t.databaseId, t.key)
      .where(sql`${t.deletedAt} is null`),
    foreignKey({
      columns: [t.workspaceId, t.databaseId],
      foreignColumns: [databases.workspaceId, databases.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.relationTargetDatabaseId],
      foreignColumns: [databases.workspaceId, databases.id],
    }),
    check(
      'properties_relation_ck',
      sql`(${t.kind} = 'relation') = (${t.relationTargetDatabaseId} is not null)`,
    ),
    check('properties_config_ck', sql`jsonb_typeof(${t.config}) = 'object'`),
    ...auditReferences(t),
  ],
);

export const propertyOptions = pgTable(
  'property_options',
  {
    ...businessFields(),
    databaseId: uuid('database_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    kind: propertyKind('kind').notNull(),
    label: text('label').notNull(),
    color: text('color'),
    position: rank('position').notNull(),
  },
  (t) => [
    unique('options_property_id_uq').on(t.workspaceId, t.propertyId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.databaseId, t.propertyId, t.kind],
      foreignColumns: [
        databaseProperties.workspaceId,
        databaseProperties.databaseId,
        databaseProperties.id,
        databaseProperties.kind,
      ],
    }).onDelete('cascade'),
    check('options_kind_ck', sql`${t.kind} in ('select','multi_select')`),
    ...auditReferences(t),
  ],
);

const valueFields = () => ({
  ...businessFields(),
  databaseId: uuid('database_id').notNull(),
  rowPageId: uuid('row_page_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  kind: propertyKind('kind').notNull(),
});
function valueReferences(t: {
  workspaceId: AnyPgColumn;
  databaseId: AnyPgColumn;
  rowPageId: AnyPgColumn;
  propertyId: AnyPgColumn;
  kind: AnyPgColumn;
  createdBy: AnyPgColumn;
  updatedBy: AnyPgColumn;
}) {
  return [
    foreignKey({
      columns: [t.workspaceId, t.databaseId, t.rowPageId],
      foreignColumns: [databaseRows.workspaceId, databaseRows.databaseId, databaseRows.pageId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.databaseId, t.propertyId, t.kind],
      foreignColumns: [
        databaseProperties.workspaceId,
        databaseProperties.databaseId,
        databaseProperties.id,
        databaseProperties.kind,
      ],
    }).onDelete('cascade'),
    ...auditReferences(t),
  ];
}

export const propertyValues = pgTable(
  'property_values',
  {
    ...valueFields(),
    textValue: text('text_value'),
    numberValue: numeric('number_value', { precision: 28, scale: 8 }),
    booleanValue: boolean('boolean_value'),
    optionId: uuid('option_id'),
    dateStart: date('date_start'),
    dateEnd: date('date_end'),
    dateTimeStart: time('date_time_start'),
    dateTimeEnd: time('date_time_end'),
    timeZone: text('time_zone'),
  },
  (t) => [
    ...valueReferences(t),
    uniqueIndex('values_live_cell_uq')
      .on(t.workspaceId, t.rowPageId, t.propertyId)
      .where(sql`${t.deletedAt} is null`),
    foreignKey({
      columns: [t.workspaceId, t.propertyId, t.optionId],
      foreignColumns: [propertyOptions.workspaceId, propertyOptions.propertyId, propertyOptions.id],
    }),
    check(
      'values_scalar_shape_ck',
      sql`
    (${t.kind} in ('text','url') and ${t.textValue} is not null and num_nonnulls(${t.numberValue}, ${t.booleanValue}, ${t.optionId}, ${t.dateStart}, ${t.dateTimeStart}) = 0)
    or (${t.kind} = 'number' and ${t.numberValue} is not null and num_nonnulls(${t.textValue}, ${t.booleanValue}, ${t.optionId}, ${t.dateStart}, ${t.dateTimeStart}) = 0)
    or (${t.kind} = 'checkbox' and ${t.booleanValue} is not null and num_nonnulls(${t.textValue}, ${t.numberValue}, ${t.optionId}, ${t.dateStart}, ${t.dateTimeStart}) = 0)
    or (${t.kind} = 'select' and ${t.optionId} is not null and num_nonnulls(${t.textValue}, ${t.numberValue}, ${t.booleanValue}, ${t.dateStart}, ${t.dateTimeStart}) = 0)
    or (${t.kind} = 'date' and num_nonnulls(${t.dateStart}, ${t.dateTimeStart}) = 1 and num_nonnulls(${t.textValue}, ${t.numberValue}, ${t.booleanValue}, ${t.optionId}) = 0)`,
    ),
    check(
      'values_date_shape_ck',
      sql`(${t.dateEnd} is null or (${t.dateStart} is not null and ${t.dateEnd} >= ${t.dateStart})) and (${t.dateTimeEnd} is null or (${t.dateTimeStart} is not null and ${t.dateTimeEnd} >= ${t.dateTimeStart})) and (${t.timeZone} is null or ${t.dateTimeStart} is not null)`,
    ),
    index('values_text_sort_idx')
      .on(t.workspaceId, t.propertyId, t.textValue, t.rowPageId)
      .where(sql`${t.deletedAt} is null`),
    index('values_number_sort_idx')
      .on(t.workspaceId, t.propertyId, t.numberValue, t.rowPageId)
      .where(sql`${t.deletedAt} is null`),
    index('values_date_sort_idx')
      .on(t.workspaceId, t.propertyId, t.dateStart, t.rowPageId)
      .where(sql`${t.deletedAt} is null`),
    index('values_datetime_sort_idx')
      .on(t.workspaceId, t.propertyId, t.dateTimeStart, t.rowPageId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const multiSelectValues = pgTable(
  'multi_select_values',
  {
    ...valueFields(),
    optionId: uuid('option_id').notNull(),
  },
  (t) => [
    ...valueReferences(t),
    foreignKey({
      columns: [t.workspaceId, t.propertyId, t.optionId],
      foreignColumns: [propertyOptions.workspaceId, propertyOptions.propertyId, propertyOptions.id],
    }),
    uniqueIndex('multi_select_live_uq')
      .on(t.workspaceId, t.rowPageId, t.propertyId, t.optionId)
      .where(sql`${t.deletedAt} is null`),
    index('multi_select_filter_idx').on(t.workspaceId, t.propertyId, t.optionId),
    check('multi_select_kind_ck', sql`${t.kind} = 'multi_select'`),
  ],
);

// Stable identity without PII. Withdrawal detaches one reference, never its assignments.
export const databasePeople = pgTable(
  'database_people',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id'),
  },
  (t) => [
    unique('database_people_workspace_id_uq').on(t.workspaceId, t.id),
    unique('database_people_member_uq').on(t.memberId),
    foreignKey({
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [member.organizationId, member.id],
    }),
  ],
);

export const databaseCellVersions = pgTable(
  'database_cell_versions',
  {
    workspaceId: uuid('workspace_id').notNull(),
    databaseId: uuid('database_id').notNull(),
    rowPageId: uuid('row_page_id').notNull(),
    propertyId: uuid('property_id').notNull(),
    version: bigint('version', { mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.rowPageId, t.propertyId] }),
    foreignKey({
      columns: [t.workspaceId, t.databaseId, t.rowPageId],
      foreignColumns: [databaseRows.workspaceId, databaseRows.databaseId, databaseRows.pageId],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.databaseId, t.propertyId],
      foreignColumns: [
        databaseProperties.workspaceId,
        databaseProperties.databaseId,
        databaseProperties.id,
      ],
    }).onDelete('cascade'),
    check('cell_version_ck', sql`${t.version} >= 0`),
  ],
);

export const databaseAssignablePeople = pgTable(
  'database_assignable_people',
  {
    workspaceId: uuid('workspace_id').notNull(),
    databaseId: uuid('database_id').notNull(),
    personId: uuid('person_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.databaseId, t.personId] }),
    foreignKey({
      columns: [t.workspaceId, t.databaseId],
      foreignColumns: [databases.workspaceId, databases.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.personId],
      foreignColumns: [databasePeople.workspaceId, databasePeople.id],
    }),
  ],
);

// Separate from lifecycle and Yjs latches: concurrent cells never upgrade a row SHARE lock.
export const databaseRowChanges = pgTable(
  'database_row_changes',
  {
    workspaceId: uuid('workspace_id').notNull(),
    databaseId: uuid('database_id').notNull(),
    rowPageId: uuid('row_page_id').notNull(),
    propertyRevision: bigint('property_revision', { mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    firstDirtyAt: time('first_dirty_at'),
    lastDirtyAt: time('last_dirty_at'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.rowPageId] }),
    foreignKey({
      columns: [t.workspaceId, t.databaseId, t.rowPageId],
      foreignColumns: [databaseRows.workspaceId, databaseRows.databaseId, databaseRows.pageId],
    }).onDelete('cascade'),
    check('row_property_revision_ck', sql`${t.propertyRevision}>=0`),
  ],
);

export const personValues = pgTable(
  'person_values',
  {
    ...valueFields(),
    memberId: uuid('member_id').notNull(),
  },
  (t) => [
    ...valueReferences(t),
    foreignKey({
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [databasePeople.workspaceId, databasePeople.id],
    }),
    uniqueIndex('person_values_live_uq')
      .on(t.workspaceId, t.rowPageId, t.propertyId, t.memberId)
      .where(sql`${t.deletedAt} is null`),
    index('person_values_filter_idx').on(t.workspaceId, t.propertyId, t.memberId),
    check('person_values_kind_ck', sql`${t.kind} = 'person'`),
  ],
);

export const relationValues = pgTable(
  'relation_values',
  {
    ...valueFields(),
    targetDatabaseId: uuid('target_database_id').notNull(),
    targetPageId: uuid('target_page_id').notNull(),
  },
  (t) => [
    ...valueReferences(t),
    foreignKey({
      columns: [t.workspaceId, t.databaseId, t.propertyId, t.targetDatabaseId],
      foreignColumns: [
        databaseProperties.workspaceId,
        databaseProperties.databaseId,
        databaseProperties.id,
        databaseProperties.relationTargetDatabaseId,
      ],
    }),
    foreignKey({
      columns: [t.workspaceId, t.targetDatabaseId, t.targetPageId],
      foreignColumns: [databaseRows.workspaceId, databaseRows.databaseId, databaseRows.pageId],
    }),
    uniqueIndex('relations_live_uq')
      .on(t.workspaceId, t.rowPageId, t.propertyId, t.targetPageId)
      .where(sql`${t.deletedAt} is null`),
    index('relations_reverse_idx').on(t.workspaceId, t.targetPageId, t.propertyId),
    check('relations_kind_ck', sql`${t.kind} = 'relation'`),
  ],
);

export const databaseViews = pgTable(
  'database_views',
  {
    ...businessFields(),
    databaseId: uuid('database_id').notNull(),
    name: text('name').notNull(),
    type: text('type').default('table').notNull(),
    position: rank('position').notNull(),
    config: jsonb('config').$type<JsonObject>().default({}).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.databaseId],
      foreignColumns: [databases.workspaceId, databases.id],
    }).onDelete('cascade'),
    check('views_type_ck', sql`${t.type} = 'table'`),
    check('views_config_ck', sql`jsonb_typeof(${t.config}) = 'object'`),
    ...auditReferences(t),
  ],
);

// Pages are joined through database_rows; never duplicate page titles/content here.
export { pages as databasePageSource };
