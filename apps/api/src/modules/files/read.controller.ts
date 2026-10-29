import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentSession } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import { FileQuota } from './file-quota.ts';
import * as reading from './read.service.ts';
@Controller('api/internal/workspaces/:workspaceId/files')
export class FileReadController {
  constructor(private readonly service: reading.FileReadService) {}
  @Post('resolve')
  @HttpCode(200)
  @FileQuota('L')
  resolve(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Body() b: unknown,
  ) {
    return this.service.invoke(s, w, 'resolve', b);
  }
  @Post('read-tickets')
  @HttpCode(200)
  @FileQuota('L')
  tickets(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Body() b: unknown,
  ) {
    return this.service.invoke(s, w, 'tickets', b);
  }
  @Post(':fileId/archive')
  @HttpCode(200)
  @FileQuota('M')
  archive(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('fileId') id: string,
    @Body() b: unknown,
  ) {
    return this.service.invoke(s, w, 'archive', b, id);
  }
  @Post(':fileId/restore')
  @HttpCode(200)
  @FileQuota('M')
  restore(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('fileId') id: string,
    @Body() b: unknown,
  ) {
    return this.service.invoke(s, w, 'restore', b, id);
  }
}
