import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { CurrentSession } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import * as security from './workspace-security.service.ts';
@Controller('api/internal/workspaces/:workspaceId')
export class WorkspaceSecurityController {
  constructor(private readonly security: security.WorkspaceSecurityService) {}
  @Get('security') read(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
  ) {
    return this.security.read(session, workspace);
  }
  @Put('security') update(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Body() input: unknown,
  ) {
    return this.security.update(session, workspace, input);
  }
  @Get('members') members(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
  ) {
    return this.security.members(session, workspace);
  }
  @Put('members/:memberId/role') role(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('memberId') member: string,
    @Body() input: unknown,
  ) {
    return this.security.role(session, workspace, member, input);
  }
}
