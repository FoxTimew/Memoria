import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { CurrentSession } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import * as shares from './shares.service.ts';
import { AccessQuota } from './access-quota.ts';
@Controller('api/internal/workspaces/:workspaceId/pages/:pageId/shares')
export class SharesController {
  constructor(private readonly shares: shares.SharesService) {}
  @Get() @AccessQuota('read') list(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') page: string,
    @Query() query: unknown,
  ) {
    return this.shares.list(session, workspace, page, query);
  }
  @Put(':memberId') @AccessQuota('mutate') change(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') page: string,
    @Param('memberId') member: string,
    @Body() body: unknown,
  ) {
    return this.shares.change(session, workspace, page, member, body);
  }
}
