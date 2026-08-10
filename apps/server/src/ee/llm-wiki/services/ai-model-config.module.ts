import { Module } from '@nestjs/common';
import { AiConfigSecretService } from './ai-config-secret.service';
import { AiModelConfigService } from './ai-model-config.service';

@Module({
  providers: [AiConfigSecretService, AiModelConfigService],
  exports: [AiModelConfigService],
})
export class AiModelConfigModule {}
