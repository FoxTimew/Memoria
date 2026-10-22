import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  apiErrorSchema,
  blockBatchSchema,
  blockSchema,
  pageCreateSchema,
  pagePatchSchema,
  pageSchema,
  paginationSchema,
  rowValuesSchema,
} from './api.ts';

extendZodWithOpenApi(z);

/** Design contract. NestJS must serve this generated document once routes exist. */
export function createOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'WorkspaceApiKey', {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
  });
  // Schemas may have been loaded before the OpenAPI extension; clone only here.
  const page = registry.register('Page', pageSchema.clone());
  const block = registry.register('Block', blockSchema.clone());
  const error = registry.register('ApiError', apiErrorSchema.clone());
  const workspaceParams = z.object({ workspaceId: z.uuid() });
  const pageParams = workspaceParams.extend({ pageId: z.uuid() });
  const databaseParams = workspaceParams.extend({ databaseId: z.uuid() });
  const conditionalHeaders = z.object({
    'If-Match': z
      .string()
      .describe(
        'Strong page aggregate ETag returned by GET. Required; * and weak tags are rejected.',
      ),
  });
  const postHeaders = z.object({
    'Idempotency-Key': z
      .string()
      .min(1)
      .max(128)
      .describe('Unique per actor, workspace and route. Retained for 24 hours by default.'),
  });
  const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
  const failures: RouteConfig['responses'] = Object.fromEntries(
    [
      [400, 'Invalid input'],
      [401, 'Missing, expired or revoked API key'],
      [403, 'Insufficient scope, page grant or authentication assurance'],
      [404, 'Not found or not visible'],
      [409, 'Idempotency key reused with another request, or operation still in progress'],
      [412, 'If-Match does not match current page version'],
      [413, 'Payload too large'],
      [422, 'Unsupported block type/version or invalid property value'],
      [428, 'Required If-Match missing'],
      [429, 'Rate limit exceeded; respect Retry-After'],
    ].map(([code, description]) => [
      String(code),
      { description: String(description), content: json(error) },
    ]),
  );
  const etag = {
    ETag: { description: 'Strong aggregate revision', schema: { type: 'string' as const } },
  };
  const security = [{ WorkspaceApiKey: [] }];
  const list = (item: z.ZodType) =>
    z.object({ data: z.array(item), nextCursor: z.string().nullable() });
  const register = (route: RouteConfig) =>
    registry.registerPath({ security, ...route, responses: { ...failures, ...route.responses } });

  register({
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/pages',
    summary: 'List visible pages (pages:read)',
    request: {
      params: workspaceParams,
      query: paginationSchema.extend({ parentId: z.uuid().optional() }),
    },
    responses: {
      200: {
        description: 'Authorized results; permissions applied before pagination',
        content: json(list(page)),
      },
    },
  });
  register({
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/pages',
    summary: 'Create page (pages:write)',
    request: {
      params: workspaceParams,
      headers: postHeaders,
      body: { required: true, content: json(pageCreateSchema) },
    },
    responses: { 201: { description: 'Created', headers: etag, content: json(page) } },
  });
  register({
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/pages/{pageId}',
    summary: 'Read page and current version (pages:read)',
    request: { params: pageParams },
    responses: {
      200: { description: 'Canonical page representation', headers: etag, content: json(page) },
    },
  });
  register({
    method: 'patch',
    path: '/v1/workspaces/{workspaceId}/pages/{pageId}',
    summary: 'Edit or move page (pages:write)',
    request: {
      params: pageParams,
      headers: conditionalHeaders,
      body: { required: true, content: json(pagePatchSchema) },
    },
    responses: { 200: { description: 'Updated page', headers: etag, content: json(page) } },
  });
  register({
    method: 'delete',
    path: '/v1/workspaces/{workspaceId}/pages/{pageId}',
    summary: 'Move page to trash (pages:write)',
    request: { params: pageParams, headers: conditionalHeaders },
    responses: { 204: { description: 'Archived; descendants are hidden transitively' } },
  });
  register({
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/pages/{pageId}/restore',
    summary: 'Restore page (pages:write)',
    request: { params: pageParams, headers: postHeaders.merge(conditionalHeaders) },
    responses: { 200: { description: 'Restored page', headers: etag, content: json(page) } },
  });
  register({
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/pages/{pageId}/blocks',
    summary: 'Read structured blocks (pages:read)',
    request: { params: pageParams, query: paginationSchema },
    responses: {
      200: {
        description:
          'Flat blocks with parentId, position and schemaVersion; page version accompanies the response',
        content: json(list(block).extend({ pageVersion: z.int().positive() })),
      },
    },
  });
  register({
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/pages/{pageId}/blocks',
    summary: 'Apply an atomic block batch (pages:write)',
    description:
      'All writes go through BlockWriteService. If-Match is the parent page ETag. The entire batch fails on conflict; no partial changes. Current permission checks precede idempotency replay.',
    request: {
      params: pageParams,
      headers: postHeaders.merge(conditionalHeaders),
      body: { required: true, content: json(blockBatchSchema) },
    },
    responses: {
      200: {
        description: 'New aggregate version',
        headers: etag,
        content: json(
          z.object({
            pageId: z.uuid(),
            version: z.int().positive(),
            changedBlockIds: z.array(z.uuid()),
          }),
        ),
      },
    },
  });
  const database = z.object({ id: z.uuid(), pageId: z.uuid(), name: z.string() });
  register({
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/databases',
    summary: 'Create database and its host page (databases:write, pages:write)',
    request: {
      params: workspaceParams,
      headers: postHeaders,
      body: { required: true, content: json(pageCreateSchema) },
    },
    responses: { 201: { description: 'Created', content: json(database) } },
  });
  register({
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/databases/{databaseId}',
    summary: 'Read database schema (databases:read)',
    request: { params: databaseParams },
    responses: {
      200: {
        description: 'Schema details are refined during the databases module',
        content: json(database),
      },
    },
  });
  register({
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/databases/{databaseId}/rows',
    summary: 'List visible rows (databases:read)',
    request: { params: databaseParams, query: paginationSchema },
    responses: {
      200: {
        description: 'Only rows and references authorized for the principal',
        content: json(list(z.object({ page, values: rowValuesSchema }))),
      },
    },
  });
  register({
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/databases/{databaseId}/rows',
    summary: 'Create row page (databases:write, pages:write)',
    request: {
      params: databaseParams,
      headers: postHeaders,
      body: {
        required: true,
        content: json(z.object({ title: z.string().max(500), values: rowValuesSchema })),
      },
    },
    responses: {
      201: {
        description: 'Created row',
        headers: etag,
        content: json(z.object({ page, values: rowValuesSchema })),
      },
    },
  });
  register({
    method: 'patch',
    path: '/v1/workspaces/{workspaceId}/databases/{databaseId}/rows/{pageId}',
    summary: 'Update row values (databases:write)',
    description: 'The row page version protects both its properties and its blocks.',
    request: {
      params: databaseParams.extend({ pageId: z.uuid() }),
      headers: conditionalHeaders,
      body: { required: true, content: json(z.object({ values: rowValuesSchema })) },
    },
    responses: {
      200: {
        description: 'Updated row',
        headers: etag,
        content: json(z.object({ page, values: rowValuesSchema })),
      },
    },
  });
  register({
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/search',
    summary: 'Search visible content (search:read, pages:read)',
    request: {
      params: workspaceParams,
      query: paginationSchema.extend({ q: z.string().min(1).max(200) }),
    },
    responses: {
      200: {
        description: 'Authorization precedes ranking, excerpts and pagination',
        content: json(list(page)),
      },
    },
  });

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Memoria Public API',
      version: '1.0.0-design',
      description:
        'Architecture contract. No HTTP endpoint is implemented in this session. File upload, view/filter and property-management routes are specified at module implementation time. All POST routes require Idempotency-Key; writes to existing page aggregates require If-Match. Error format is shared across /v1.',
    },
    servers: [{ url: 'https://localhost' }],
  });
}
