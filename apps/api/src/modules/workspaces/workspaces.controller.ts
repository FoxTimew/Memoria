import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import * as auth from '../auth/auth.service.ts';
import * as workspaces from './workspaces.service.ts';

@Controller('api/internal/workspaces')
export class WorkspacesController {
  constructor(
    private readonly auth: auth.AuthService,
    private readonly workspaces: workspaces.WorkspacesService,
  ) {}

  @Get()
  async list(@Req() request: Request) {
    const user = await this.auth.requireUser(request.headers);
    return this.workspaces.list(user.id);
  }

  @Post()
  async create(@Req() request: Request, @Body() input: unknown) {
    const user = await this.auth.requireUser(request.headers);
    return this.workspaces.create(user.id, input);
  }
}
