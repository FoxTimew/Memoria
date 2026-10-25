import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import { createAuth, handleAuthRequest, readAssurance } from '@memoria/auth';
import type { AuthOptions } from '@memoria/auth';
import type { WriteTransaction } from '@memoria/db';
import * as database from '../../database.module.ts';
import { readConfig } from '../../config.ts';

@Injectable()
export class AuthService {
  private readonly config = readConfig();
  private readonly options: AuthOptions = {
    origin: this.config.APP_ORIGIN,
    secret: this.config.BETTER_AUTH_SECRET,
  };
  readonly auth;
  readonly handler;

  constructor(private readonly database: database.DatabaseService) {
    this.auth = createAuth(database.db, this.options);
    this.handler = {
      handler: (request: Request) => handleAuthRequest(database.db, this.options, request),
    };
  }

  inTransaction(transaction: WriteTransaction) {
    return createAuth(transaction, this.options);
  }

  async authenticate(headers: IncomingHttpHeaders) {
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!session) throw new UnauthorizedException('Connectez-vous pour continuer.');
    if (!session.user.emailVerified) throw new ForbiddenException('Vérifiez votre adresse email.');
    if (!(await readAssurance(this.database.db, session.session.id)).content)
      throw new ForbiddenException({
        code: 'STRONG_AUTH_REQUIRED',
        message: 'Vérifiez votre second facteur.',
      });
    return session;
  }
}
