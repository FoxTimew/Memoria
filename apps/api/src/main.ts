import 'reflect-metadata';
import { Catch, Controller, Get, HttpException, Module } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { readConfig } from './config.ts';
import * as database from './database.module.ts';
import { AuthModule } from './modules/auth/auth.module.ts';
import { AuthService } from './modules/auth/auth.service.ts';
import { WorkspacesModule } from './modules/workspaces/workspaces.module.ts';

@Controller('api/health')
class HealthController {
  constructor(private readonly database: database.DatabaseService) {}
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
    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
    } else {
      console.error('API request failed:', error instanceof Error ? error.name : 'UnknownError');
      response.status(500).json({ message: 'Une erreur est survenue. Réessayez.' });
    }
  }
}

@Module({
  imports: [database.DatabaseModule, AuthModule, WorkspacesModule],
  controllers: [HealthController],
})
class AppModule {}

const config = readConfig();
const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
app.set(
  'trust proxy',
  config.TRUSTED_PROXY_CIDRS.split(',').map((cidr) => cidr.trim()),
);
app.disable('x-powered-by');
app.useGlobalFilters(new SafeExceptionFilter());
app.enableShutdownHooks();
app.use((request: Request, response: Response, next: NextFunction) => {
  request.headers['x-memoria-client-ip'] = request.ip ?? request.socket.remoteAddress ?? 'unknown';
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

// Only the simple login surface is exposed. Plugin mutations stay behind Nest services.
const authRoutes = new Set([
  'POST /sign-up/email',
  'POST /sign-in/email',
  'POST /sign-out',
  'POST /send-verification-email',
  'GET /verify-email',
  'GET /get-session',
]);
const handler = toNodeHandler(app.get(AuthService).auth);
app.use('/api/auth', (request: Request, response: Response) => {
  if (!authRoutes.has(`${request.method} ${request.path}`)) {
    response.status(404).json({ message: 'Route indisponible.' });
    return;
  }
  return handler(request, response);
});
app.use(express.json({ limit: '32kb' }));
await app.get(database.DatabaseService).ready();
await app.listen(config.API_PORT, config.API_HOST);
