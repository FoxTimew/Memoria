import assert from 'node:assert/strict';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { FILE_QUOTA } from '../modules/files/file-quota.ts';
import { IS_PUBLIC } from '../modules/auth/public.decorator.ts';

/** Fail if a new HTTP handler is absent from the executable R12 matrix. */
export function assertFileRouteMatrix(
  controller: { prototype: object },
  matrix: Record<string, string>,
) {
  assert.notEqual(Reflect.getMetadata(IS_PUBLIC, controller), true);
  const proto = controller.prototype as Record<string, object>;
  const handlers = Object.getOwnPropertyNames(proto).filter(
    (name) => typeof Reflect.getMetadata(METHOD_METADATA, proto[name]!) === 'number',
  );
  assert.deepEqual(handlers.sort(), Object.keys(matrix).sort(), 'Update R12 attacks and quotas');
  for (const name of handlers) {
    assert.equal(Reflect.getMetadata(FILE_QUOTA, proto[name]!), matrix[name]);
    assert.notEqual(Reflect.getMetadata(IS_PUBLIC, proto[name]!), true);
  }
}
