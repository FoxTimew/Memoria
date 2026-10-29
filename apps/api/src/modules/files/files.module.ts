import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.ts';
import { FilesService } from './files.service.ts';
import { FileReadController } from './read.controller.ts';
import { FileReadService } from './read.service.ts';
@Module({
  controllers: [FilesController, FileReadController],
  providers: [FilesService, FileReadService],
  exports: [FilesService],
})
export class FilesModule {}
