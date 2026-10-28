import 'reflect-metadata';
import { Catch, Controller, Get, HttpException, Module } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { readConfig } from './config.ts';
import * as database from './database.module.ts';
import { AuthModule } from './modules/auth/auth.module.ts';
import { Public } from './modules/auth/public.decorator.ts';
import { WorkspacesModule } from './modules/workspaces/workspaces.module.ts';
import { PagesModule } from './modules/pages/pages.module.ts';
import { SecurityPolicyError } from '@memoria/auth';
import { DatabaseFault } from '@memoria/db';
import { DatabasesModule } from './modules/databases/databases.module.ts';

@Controller('api/health')
class HealthController {
  constructor(private readonly database: database.DatabaseService) {}
  @Public()
  @Get()
  async health() {
    await this.database.ready();
    return { status: 'ok', service: 'api' };
  }
}

@Catch()
class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof DatabaseFault) {
      response.status(error.status).json({
        code: error.code,
        ...(error.current === undefined ? {} : { current: error.current }),
      });
    } else if (error instanceof SecurityPolicyError) {
      response.status(error.status).json({ code: error.code, message: error.code });
    } else if (error instanceof HttpException) {
      const body = error.getResponse();
      if (error.getStatus() === 429 && typeof body === 'object' && 'retryAfter' in body)
        response.setHeader('Retry-After', String(body.retryAfter));
      response.status(error.getStatus()).json(error.getResponse());
    } else if (
      error &&
      typeof error === 'object' &&
      'type' in error &&
      ['entity.too.large', 'entity.parse.failed'].includes(String(error.type))
    ) {
      response
        .status(error.type === 'entity.too.large' ? 413 : 400)
        .json({ message: 'Corps JSON invalide ou trop volumineux.' });
    } else {
      console.error('API request failed:', error instanceof Error ? error.name : 'UnknownError');
      response.status(500).json({ message: 'Une erreur est survenue. Réessayez.' });
    }
  }
}

@Module({
  imports: [database.DatabaseModule, AuthModule, WorkspacesModule, PagesModule, DatabasesModule],
  controllers: [HealthController],
})
export class AppModule {}

export function configureApplication(app: NestExpressApplication) {
  const config = readConfig();
  app.set(
    'trust proxy',
    config.TRUSTED_PROXY_CIDRS.split(',').map((cidr) => cidr.trim()),
  );
  app.disable('x-powered-by');
  app.useGlobalFilters(new SafeExceptionFilter());
  app.enableShutdownHooks();
  app.use((request: Request, response: Response, next: NextFunction) => {
    request.headers['x-memoria-client-ip'] =
      request.ip ?? request.socket.remoteAddress ?? 'unknown';
    response.setHeader('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin !== config.APP_ORIGIN
    ) {
      response.status(403).json({ message: 'Origine non autorisée.' });
      return;
    }
    next();
  });

  // Better Auth must receive the unconsumed stream; its @Public controller owns parsing.
  const parseJson = express.json({ limit: '1mb' });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (/^\/api\/auth(?:\/|$)/i.test(request.path)) return next();
    return parseJson(request, response, next);
  });
}
