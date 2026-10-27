import { Module } from '@nestjs/common';
import { DatabasesController } from './databases.controller.ts';
import { DatabasesService } from './databases.service.ts';
import { DatabaseObjectsService } from './database-objects.service.ts';
import { DatabaseObjectsController } from './database-objects.controller.ts';
import { BlockWriteService } from '../blocks/block-write.service.ts';
import { DatabaseAdmission } from './database-quota.ts';
import { readDatabaseLimits } from '@memoria/db';
import { DatabaseAccessController } from './database-access.controller.ts';
@Module({
  controllers: [DatabasesController, DatabaseObjectsController, DatabaseAccessController],
  exports: [DatabaseObjectsService],
  providers: [
    DatabasesService,
    DatabaseObjectsService,
    BlockWriteService,
    {
      provide: DatabaseAdmission,
      useFactory: () => {
        const l = readDatabaseLimits();
        return new DatabaseAdmission(l.concurrentQueries, l.queuedQueries, l.queryTimeoutMs);
      },
    },
  ],
})
export class DatabasesModule {}
