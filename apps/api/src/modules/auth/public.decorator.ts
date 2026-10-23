import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = Symbol('memoria.public');
/** Explicitly delegate authentication to a public endpoint or the Better Auth handler. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
