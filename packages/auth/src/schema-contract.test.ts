import { getAuthTables } from 'better-auth/db';
import { getTableColumns, is, Table } from 'drizzle-orm';
import * as schema from '@memoria/db/schema';
import { describe, expect, it } from 'vitest';
import { authSchemaContract } from './schema-contract';

describe('Better Auth schema contract', () => {
  const models = getAuthTables(authSchemaContract);
  for (const [modelName, model] of Object.entries(models)) {
    it(`contains every installed plugin field for ${modelName}`, () => {
      const table: unknown = Reflect.get(schema, modelName);
      if (!is(table, Table)) throw new Error(`Missing auth model: ${modelName}`);
      const columns = getTableColumns(table);
      expect(columns).toHaveProperty('id');
      for (const field of Object.keys(model.fields))
        expect(columns, `${modelName}.${field}`).toHaveProperty(field);
    });
  }
});
