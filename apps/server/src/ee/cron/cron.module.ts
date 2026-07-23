import { Module } from '@nestjs/common';
import { SsoModule } from '../sso/sso.module';
import { SsoUserSyncController } from './sso-user-sync.controller';
import { SsoUserSyncService } from './sso-user-sync.service';

@Module({
  imports: [SsoModule],
  controllers: [SsoUserSyncController],
  providers: [SsoUserSyncService],
})
export class CronModule {}
