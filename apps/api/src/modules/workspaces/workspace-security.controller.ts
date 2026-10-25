import { Body, Controller, Get, Param, Put, Delete, Query } from '@nestjs/common';
import { CurrentSession, CurrentAuthHeaders } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import * as security from './workspace-security.service.ts';
import * as members from './members.service.ts';
import { AccessQuota } from './access-quota.ts';
@Controller('api/internal/workspaces/:workspaceId')
@AccessQuota('read')
export class WorkspaceSecurityController {
  constructor(
    private readonly security: security.WorkspaceSecurityService,
    private readonly membersService: members.MembersService,
  ) {}
  @Get('security') read(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
  ) {
    return this.security.read(session, workspace);
  }
  @Put('security') @AccessQuota('mutate') update(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Body() input: unknown,
  ) {
    return this.security.update(session, workspace, input);
  }
  @Get('members') @AccessQuota('read') members(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Query() query: unknown,
  ) {
    return this.membersService.list(session, workspace, query);
  }
  @Put('members/:memberId/role') @AccessQuota('mutate') role(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('memberId') member: string,
    @Body() input: unknown,
    @CurrentAuthHeaders() headers: Headers,
  ) {
    return this.membersService.change(session, headers, workspace, member, input);
  }
  @Delete('members/:memberId') @AccessQuota('mutate') remove(
    @CurrentSession() session: AuthenticatedSession,
    @CurrentAuthHeaders() headers: Headers,
    @Param('workspaceId') workspace: string,
    @Param('memberId') member: string,
    @Body() body: unknown,
  ) {
    return this.membersService.change(session, headers, workspace, member, body, true);
  }
}
