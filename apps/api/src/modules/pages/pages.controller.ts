import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentSession } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import * as pages from './pages.service.ts';
import { ContentQuota } from './content-quota.ts';

@Controller('api/internal/workspaces/:workspaceId')
@ContentQuota()
export class PagesController {
  constructor(private readonly pages: pages.PagesService) {}
  @Get('pages') list(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
  ) {
    return this.pages.list(session, workspace);
  }
  @Post('pages') create(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Body() body: unknown,
  ) {
    return this.pages.create(session, workspace, body);
  }
  @Get('pages/:pageId') get(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
  ) {
    return this.pages.get(session, workspace, id);
  }
  @Get('pages/:pageId/version') version(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
  ) {
    return this.pages.get(session, workspace, id, true);
  }
  @Put('pages/:pageId') save(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.save(session, workspace, id, body);
  }
  @Post('pages/:pageId/collaboration') openCollaboration(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') page: string,
  ) {
    return this.pages.openCollaboration(session, workspace, page);
  }
  @Put('pages/:pageId/content') content(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') page: string,
    @Body() input: unknown,
  ) {
    return this.pages.writeCollaboration(session, workspace, page, input);
  }
  @Post('pages/:pageId/rename') rename(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') page: string,
    @Body() input: unknown,
  ) {
    return this.pages.rename(session, workspace, page, input);
  }
  @Post('pages/:pageId/move') move(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.mutate(session, workspace, id, 'move', body);
  }
  @Post('pages/:pageId/move/preview') previewMove(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.mutate(session, workspace, id, 'move', body, true);
  }
  @Post('pages/:pageId/restore/preview') previewRestore(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.mutate(session, workspace, id, 'restore', body, true);
  }
  @Post('pages/:pageId/archive') archive(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.mutate(session, workspace, id, 'archive', body);
  }
  @Post('pages/:pageId/restore') restore(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.mutate(session, workspace, id, 'restore', body);
  }
  @Get('search') search(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
    @Query('q') query: string,
  ) {
    return this.pages.search(session, workspace, query);
  }
  @Get('page-access') accessSnapshot(
    @CurrentSession() session: AuthenticatedSession,
    @Param('workspaceId') workspace: string,
  ) {
    return this.pages.accessSnapshot(session, workspace);
  }
}
