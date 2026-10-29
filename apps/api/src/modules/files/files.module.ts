import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.ts';
import { FilesService } from './files.service.ts';
@Module({ controllers: [FilesController], providers: [FilesService], exports: [FilesService] })
export class FilesModule {}
