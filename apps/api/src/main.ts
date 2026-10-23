import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { DatabaseService } from './database.module.ts';

const config = readConfig();
const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
configureApplication(app);
await app.get(DatabaseService).ready();
await app.listen(config.API_PORT, config.API_HOST);
