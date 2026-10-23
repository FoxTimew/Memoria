import { Module } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service.ts';
import { WorkspacesController } from './workspaces.controller.ts';

@Module({ providers: [WorkspacesService], controllers: [WorkspacesController] })
export class WorkspacesModule {}
