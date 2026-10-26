import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentSession, CurrentAuthHeaders } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import * as invitations from './invitations.service.ts';
import { AccessQuota } from './access-quota.ts';
@Controller('api/internal')
export class InvitationsController {
  constructor(private readonly invitations: invitations.InvitationsService) {}
  @Get('workspaces/:workspaceId/invitations') @AccessQuota('read') list(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Query() query: unknown,
  ) {
    return this.invitations.list(session, workspace, query);
  }
  @Post('workspaces/:workspaceId/invitations') @AccessQuota('send') create(
    @CurrentSession() session: AuthenticatedSession,
    @CurrentAuthHeaders() headers: Headers,
    @Param('workspaceId') workspace: string,
    @Body() body: unknown,
  ) {
    return this.invitations.create(session, headers, workspace, body);
  }
  @Post('workspaces/:workspaceId/invitations/:id/resend') @AccessQuota('send') resend(
    @CurrentSession() session: AuthenticatedSession,
    @CurrentAuthHeaders() headers: Headers,
    @Param('workspaceId') workspace: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.invitations.create(session, headers, workspace, body, id);
  }
  @Post('workspaces/:workspaceId/invitations/:id/cancel') @AccessQuota('mutate') cancel(
    @CurrentSession() session: AuthenticatedSession,
    @CurrentAuthHeaders() headers: Headers,
    @Param('workspaceId') workspace: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.invitations.cancel(session, headers, workspace, id, body);
  }
  @Get('invitations') @AccessQuota('read') own(
    @CurrentSession() session: AuthenticatedSession,
    @Query() query: unknown,
  ) {
    return this.invitations.own(session, query);
  }
  @Post('invitations/resolve') @AccessQuota('read') resolve(
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: unknown,
  ) {
    return this.invitations.resolve(session, body);
  }
  @Post('invitations/accept') @AccessQuota('respond') accept(
    @CurrentSession() session: AuthenticatedSession,
    @CurrentAuthHeaders() headers: Headers,
    @Body() body: unknown,
  ) {
    return this.invitations.respond(session, headers, body, true);
  }
  @Post('invitations/reject') @AccessQuota('respond') reject(
    @CurrentSession() session: AuthenticatedSession,
    @CurrentAuthHeaders() headers: Headers,
    @Body() body: unknown,
  ) {
    return this.invitations.respond(session, headers, body, false);
  }
  @Get('workspaces/:workspaceId/arrival') @AccessQuota('read') arrival(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
  ) {
    return this.invitations.arrival(session, workspace);
  }
}
