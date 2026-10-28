import { Global, Injectable, Module } from '@nestjs/common';
import { createDatabase } from '@memoria/db';
import { readConfig } from './config.ts';

@Injectable()
export class DatabaseService {
  private readonly connection = createDatabase(readConfig().DATABASE_URL);
  readonly db = this.connection.db;
  readonly pool = this.connection.pool;

  async ready() {
    await this.connection.pool.query('select 1');
  }
  async onApplicationShutdown() {
    await this.connection.pool.end();
  }
}

@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
