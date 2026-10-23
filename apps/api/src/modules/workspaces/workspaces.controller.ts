import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.ts';
import type { AuthenticatedUser } from '../auth/current-user.decorator.ts';
import * as workspaces from './workspaces.service.ts';

@Controller('api/internal/workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: workspaces.WorkspacesService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.workspaces.list(user.id);
  }

  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() input: unknown) {
    return this.workspaces.create(user.id, input);
  }
}
