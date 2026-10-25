import { All, Controller, Req, Res, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { toNodeHandler } from 'better-auth/node';
import * as auth from './auth.service.ts';
import { Public } from './public.decorator.ts';

const authRoutes = new Set([
  'POST /sign-up/email',
  'POST /sign-in/email',
  'POST /sign-out',
  'POST /send-verification-email',
  'GET /verify-email',
  'GET /get-session',
  'POST /verify-password',
  'GET /security/status',
  'POST /security/challenge',
  'POST /security/recovery-codes',
  'POST /two-factor/enable',
  'POST /two-factor/verify-totp',
  'POST /two-factor/disable',
  'GET /passkey/generate-register-options',
  'POST /passkey/verify-registration',
  'GET /passkey/generate-authenticate-options',
  'POST /passkey/verify-authentication',
  'POST /passkey/delete-passkey',
  'POST /passkey/update-passkey',
  'POST /security/request-password-reset',
  'POST /security/recover',
  'POST /security/operator-recover',
  'POST /security/recovery-remove-factor',
  'POST /security/recovery-finish',
  'POST /reset-password',
]);

@Public()
@Controller('api/auth')
export class AuthController {
  private readonly handler;

  constructor(auth: auth.AuthService) {
    this.handler = toNodeHandler(auth.handler);
  }

  @All('*path')
  handle(@Req() request: Request, @Res() response: Response) {
    // Nest keeps the full path, unlike a mounted Express middleware.
    const path = request.path.slice('/api/auth'.length);
    if (!authRoutes.has(`${request.method} ${path}`))
      throw new NotFoundException('Route indisponible.');
    return this.handler(request, response);
  }
}
