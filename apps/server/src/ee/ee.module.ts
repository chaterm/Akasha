import { Module } from '@nestjs/common';
import { SsoModule } from './sso/sso.module';

@Module({
  imports: [SsoModule],
})
export class EeModule {}
