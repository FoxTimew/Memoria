import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentSession } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import * as databases from './databases.service.ts';
import { DatabaseQuota } from './database-quota.ts';
@Controller('api/internal/workspaces/:workspaceId/databases')
export class DatabasesController {
  constructor(private readonly databases: databases.DatabasesService) {}
  @Post(':databaseId/query')
  @HttpCode(200)
  @DatabaseQuota('L')
  query(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('databaseId') database: string,
    @Body() body: unknown,
  ) {
    return this.databases.query(session, workspace, database, body);
  }
}
