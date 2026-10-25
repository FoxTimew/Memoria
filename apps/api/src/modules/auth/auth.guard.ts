import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import * as core from '@nestjs/core';
import * as auth from './auth.service.ts';
import type { AuthenticatedRequest } from './current-user.decorator.ts';
import { IS_PUBLIC } from './public.decorator.ts';
import * as database from '../../database.module.ts';
import { readConfig } from '../../config.ts';
import {
  CONTENT_QUOTA,
  admitContentIp,
  admitContentAccount,
  contentQuotaRead,
} from '../pages/content-quota.ts';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: core.Reflector,
    private readonly auth: auth.AuthService,
    private readonly database: database.DatabaseService,
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
    const limited = this.reflector.getAllAndOverride<boolean>(CONTENT_QUOTA, [
      context.getHandler(),
      context.getClass(),
    ]);
    const route = String(request.route?.path ?? 'unknown');
    const secret = readConfig().BETTER_AUTH_SECRET;
    if (limited)
      await admitContentIp(
        this.database.db,
        secret,
        route,
        request.method,
        request.ip ?? request.socket.remoteAddress ?? 'unknown',
      );
    const identity = await this.auth.authenticate(request.headers);
    if (limited)
      await admitContentAccount(
        this.database.db,
        secret,
        identity.user.id,
        String(request.params.workspaceId),
        contentQuotaRead(request.method, route),
      );
    request.user = identity.user;
    request.authSession = identity.session;
    return true;
  }
}
