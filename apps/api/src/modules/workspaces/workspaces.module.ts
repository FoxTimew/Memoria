import { Module } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service.ts';
import { WorkspacesController } from './workspaces.controller.ts';
import { WorkspaceSecurityService } from './workspace-security.service.ts';
import { WorkspaceSecurityController } from './workspace-security.controller.ts';
import { InvitationsService } from './invitations.service.ts';
import { InvitationsController } from './invitations.controller.ts';
import { MembersService } from './members.service.ts';
import { SharesService } from './shares.service.ts';
import { SharesController } from './shares.controller.ts';

@Module({
  providers: [
    WorkspacesService,
    WorkspaceSecurityService,
    InvitationsService,
    MembersService,
    SharesService,
  ],
  controllers: [
    WorkspacesController,
    WorkspaceSecurityController,
    InvitationsController,
    SharesController,
  ],
})
export class WorkspacesModule {}
