import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import { createAuth } from '@memoria/auth';
import type { AuthOptions } from '@memoria/auth';
import type { WriteTransaction } from '@memoria/db';
import nodemailer from 'nodemailer';
import * as database from '../../database.module.ts';
import { readConfig } from '../../config.ts';

@Injectable()
export class AuthService {
  private readonly config = readConfig();
  private readonly mail = nodemailer.createTransport({
    host: this.config.SMTP_HOST,
    port: this.config.SMTP_PORT,
    secure: this.config.SMTP_SECURE,
    requireTLS: this.config.NODE_ENV === 'production' && !this.config.SMTP_SECURE,
    ...(this.config.SMTP_USER
      ? { auth: { user: this.config.SMTP_USER, pass: this.config.SMTP_PASSWORD } }
      : {}),
    connectionTimeout: 10000,
    socketTimeout: 10000,
  });
  private readonly options: AuthOptions = {
    origin: this.config.APP_ORIGIN,
    secret: this.config.BETTER_AUTH_SECRET,
    sendVerificationEmail: async (email, url) => {
      try {
        await this.mail.sendMail({
          from: this.config.SMTP_FROM,
          to: email,
          subject: 'Vérifiez votre adresse email — Memoria',
          text: `Bienvenue dans Memoria.\n\nConfirmez votre adresse email avec ce lien (valable une heure) :\n${url}\n\nSi vous n'avez pas créé ce compte, ignorez cet email.`,
        });
      } catch {
        // SMTP errors may contain recipients or credentials; never forward them.
        throw new Error('Verification email delivery failed');
      }
    },
  };
  readonly auth;

  constructor(private readonly database: database.DatabaseService) {
    this.auth = createAuth(database.db, this.options);
  }

  inTransaction(transaction: WriteTransaction) {
    return createAuth(transaction, this.options);
  }

  async authenticate(headers: IncomingHttpHeaders) {
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    if (!session) throw new UnauthorizedException('Connectez-vous pour continuer.');
    if (!session.user.emailVerified) throw new ForbiddenException('Vérifiez votre adresse email.');
    return session.user;
  }

  onApplicationShutdown() {
    this.mail.close();
  }
}
