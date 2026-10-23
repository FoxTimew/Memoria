import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createBlockRegistry } from '@memoria/block-catalog/server';
import { organization } from '@memoria/db';
import { pageETag } from '@memoria/contracts';

@Injectable()
class CatalogProbe {
  readonly version = createBlockRegistry().get('gamedev.character-card').version;
}

@Injectable()
class ConsumerProbe {
  constructor(readonly catalog: CatalogProbe) {}
}

@Module({ providers: [CatalogProbe, ConsumerProbe] })
class ProbeModule {}

assert.deepEqual(Reflect.getMetadata('design:paramtypes', ConsumerProbe), [CatalogProbe]);
const app = await NestFactory.createApplicationContext(ProbeModule, { logger: false });
try {
  assert.equal(app.get(ConsumerProbe).catalog.version, 2);
  assert.equal(organization.id.name, 'id');
  const pageId = '996208b2-4a76-4c35-bb14-b27731fc8417';
  assert.equal(pageETag(pageId, 1), `"page-${pageId}-v1"`);
  console.info('Nest decorators, dependency injection and workspace TypeScript exports: OK');
} finally {
  await app.close();
}
