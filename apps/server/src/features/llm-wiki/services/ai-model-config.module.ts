import { Module } from '@nestjs/common';
import { AiConfigSecretService } from './ai-config-secret.service';
import { AiModelConfigService } from './ai-model-config.service';
import { AiModelConfigTestService } from './ai-model-config-test.service';

@Module({
  providers: [
    AiConfigSecretService,
    AiModelConfigService,
    AiModelConfigTestService,
  ],
  exports: [AiModelConfigService, AiModelConfigTestService],
})
export class AiModelConfigModule {}
