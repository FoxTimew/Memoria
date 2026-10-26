import { createParamDecorator, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Auth } from '@memoria/auth';

export type AuthenticatedUser = Auth['$Infer']['Session']['user'];
export type AuthenticatedSession = Auth['$Infer']['Session']['session'];
export type AuthenticatedRequest = Request & {
  user?: AuthenticatedUser;
  authSession?: AuthenticatedSession;
};

/** Read only the identity established once by the global guard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new UnauthorizedException('Connectez-vous pour continuer.');
    return user;
  },
);

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedSession => {
    const session = context.switchToHttp().getRequest<AuthenticatedRequest>().authSession;
    if (!session) throw new UnauthorizedException();
    return session;
  },
);
/** Native Better Auth server calls require the original cookie. Authorization still uses
 * CurrentSession from the global guard, then rechecks its SQL identity under transaction. */
export const CurrentAuthHeaders = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Headers => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.authSession) throw new UnauthorizedException();
    return new Headers({ cookie: request.headers.cookie ?? '' });
  },
);
