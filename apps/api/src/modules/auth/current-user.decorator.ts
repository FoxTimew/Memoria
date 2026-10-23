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
