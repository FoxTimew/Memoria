import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import * as core from '@nestjs/core';
import * as auth from './auth.service.ts';
import type { AuthenticatedRequest } from './current-user.decorator.ts';
import { IS_PUBLIC } from './public.decorator.ts';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: core.Reflector,
    private readonly auth: auth.AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    )
      return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = await this.auth.authenticate(request.headers);
    request.user = identity.user;
    request.authSession = identity.session;
    return true;
  }
}
