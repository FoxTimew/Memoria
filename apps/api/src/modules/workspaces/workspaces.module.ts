import { Module } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service.ts';
import { WorkspacesController } from './workspaces.controller.ts';
import { WorkspaceSecurityService } from './workspace-security.service.ts';
import { WorkspaceSecurityController } from './workspace-security.controller.ts';

@Module({
  providers: [WorkspacesService, WorkspaceSecurityService],
  controllers: [WorkspacesController, WorkspaceSecurityController],
})
export class WorkspacesModule {}
