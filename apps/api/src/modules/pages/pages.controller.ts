import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.ts';
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts';
import * as pages from './pages.service.ts';

@Controller('api/internal/workspaces/:workspaceId')
export class PagesController {
  constructor(private readonly pages: pages.PagesService) {}
  @Get('pages') list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspace: string,
  ) {
    return this.pages.list(user.id, workspace);
  }
  @Post('pages') create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspace: string,
    @Body() body: unknown,
  ) {
    return this.pages.create(user.id, workspace, body);
  }
  @Get('pages/:pageId') get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
  ) {
    return this.pages.get(user.id, workspace, id);
  }
  @Get('pages/:pageId/version') version(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
  ) {
    return this.pages.get(user.id, workspace, id, true);
  }
  @Put('pages/:pageId') save(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.save(user.id, workspace, id, body);
  }
  @Post('pages/:pageId/move') move(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.mutate(user.id, workspace, id, 'move', body);
  }
  @Post('pages/:pageId/archive') archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.mutate(user.id, workspace, id, 'archive', body);
  }
  @Post('pages/:pageId/restore') restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspace: string,
    @Param('pageId') id: string,
    @Body() body: unknown,
  ) {
    return this.pages.mutate(user.id, workspace, id, 'restore', body);
  }
  @Get('search') search(
    @CurrentUser() user: AuthenticatedUser,
    @Param('workspaceId') workspace: string,
    @Query('q') query: string,
  ) {
    return this.pages.search(user.id, workspace, query);
  }
}
