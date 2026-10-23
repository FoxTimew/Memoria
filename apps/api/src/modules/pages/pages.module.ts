import { Module } from '@nestjs/common';
import { PagesController } from './pages.controller.ts';
import { PagesService } from './pages.service.ts';
import { BlockWriteService } from '../blocks/block-write.service.ts';
@Module({ controllers: [PagesController], providers: [PagesService, BlockWriteService] })
export class PagesModule {}
