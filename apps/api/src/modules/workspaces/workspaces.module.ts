import { Module } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service.ts';
import { WorkspacesController } from './workspaces.controller.ts';
import { WorkspaceSecurityService } from './workspace-security.service.ts';
import { WorkspaceSecurityController } from './workspace-security.controller.ts';
import { InvitationsService } from './invitations.service.ts';
import { InvitationsController } from './invitations.controller.ts';
import { MembersService } from './members.service.ts';

@Module({
  providers: [WorkspacesService, WorkspaceSecurityService, InvitationsService, MembersService],
  controllers: [WorkspacesController, WorkspaceSecurityController, InvitationsController],
})
export class WorkspacesModule {}
