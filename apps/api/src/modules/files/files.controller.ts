import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentSession } from '../auth/current-user.decorator.ts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import * as files from './files.service.ts';
import { FileQuota } from './file-quota.ts';
@Controller('api/internal/workspaces/:workspaceId/file-uploads')
export class FilesController {
  constructor(private readonly files: files.FilesService) {}
  @Post('pending')
  @HttpCode(200)
  @FileQuota('L')
  pending(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Body() b: unknown,
  ) {
    return this.files.invoke(s, w, 'pending', undefined, b);
  }
  @Post()
  @HttpCode(201)
  @FileQuota('U')
  initiate(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Body() b: unknown,
  ) {
    return this.files.invoke(s, w, 'initiate', undefined, b);
  }
  @Get(':uploadId')
  @FileQuota('L')
  status(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('uploadId') id: string,
  ) {
    return this.files.invoke(s, w, 'status', id);
  }
  @Post(':uploadId/resume')
  @HttpCode(200)
  @FileQuota('U')
  resume(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('uploadId') id: string,
    @Body() b: unknown,
  ) {
    return this.files.invoke(s, w, 'resume', id, b);
  }
  @Post(':uploadId/parts')
  @HttpCode(200)
  @FileQuota('P')
  sign(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('uploadId') id: string,
    @Body() b: unknown,
  ) {
    return this.files.invoke(s, w, 'sign', id, b);
  }
  @Post(':uploadId/complete')
  @HttpCode(202)
  @FileQuota('U')
  complete(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('uploadId') id: string,
    @Body() b: unknown,
  ) {
    return this.files.invoke(s, w, 'complete', id, b);
  }
  @Delete(':uploadId')
  @HttpCode(202)
  @FileQuota('U')
  cancel(
    @CurrentSession() s: AuthenticatedSession,
    @Param('workspaceId') w: string,
    @Param('uploadId') id: string,
    @Body() b: unknown,
  ) {
    return this.files.invoke(s, w, 'cancel', id, b);
  }
}
