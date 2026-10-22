import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service.ts';

@Global()
@Module({ providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
