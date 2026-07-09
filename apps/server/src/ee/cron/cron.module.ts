import { Module } from '@nestjs/common';
import { SsoModule } from '../sso/sso.module';
import { SsoUserSyncService } from './sso-user-sync.service';

@Module({
  imports: [SsoModule],
  providers: [SsoUserSyncService],
})
export class CronModule {}
