import { Body, Controller, Post, Param, Put, HttpCode } from '@nestjs/common';
import { CurrentSession } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import * as objects from './database-objects.service.ts';
import { DatabaseQuota } from './database-quota.ts';
import { ContentQuota } from '../pages/content-quota.ts';
@Controller('api/internal/workspaces/:workspaceId')
export class DatabaseAccessController {
  constructor(private readonly objects: objects.DatabaseObjectsService) {}
  @Post('row-access')
  @HttpCode(200)
  @DatabaseQuota('L')
  access(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Body() body: unknown,
  ) {
    return this.objects.rowAccess(s, w, body);
  }
  @Post('databases/:databaseId/rows/:rowId/collaboration')
  @HttpCode(200)
  @DatabaseQuota('L')
  open(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('rowId') r: string,
  ) {
    return this.objects.collaboration(s, w, b, r);
  }
  @Put('databases/:databaseId/rows/:rowId/content')
  @HttpCode(200)
  @ContentQuota()
  write(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('databaseId') b: string,
    @Param('rowId') r: string,
    @Body() body: unknown,
  ) {
    return this.objects.collaboration(s, w, b, r, body);
  }
}
