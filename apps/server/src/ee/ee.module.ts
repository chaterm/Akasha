import { Module } from '@nestjs/common';
import { SsoModule } from './sso/sso.module';
import { ApiKeyModule } from './api-key/api-key.module';

@Module({
  imports: [SsoModule, ApiKeyModule],
})
export class EeModule {}
