import { Module } from '@nestjs/common';
import { PagesController } from './pages.controller.ts';
import { PagesService } from './pages.service.ts';
import { BlockWriteService } from '../blocks/block-write.service.ts';
import { DatabasesModule } from '../databases/databases.module.ts';
@Module({
  imports: [DatabasesModule],
  controllers: [PagesController],
  providers: [PagesService, BlockWriteService],
})
export class PagesModule {}
