import { Module } from '@nestjs/common';
import { DatabasesController } from './databases.controller.ts';
import { DatabasesService } from './databases.service.ts';
@Module({ controllers: [DatabasesController], providers: [DatabasesService] })
export class DatabasesModule {}
