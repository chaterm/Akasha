import { Module } from '@nestjs/common';
import { AiModelConfigModule } from '../llm-wiki/services/ai-model-config.module';
import { EditorAiController } from './editor-ai.controller';
import { EditorAiService } from './editor-ai.service';

@Module({
  imports: [AiModelConfigModule],
  controllers: [EditorAiController],
  providers: [EditorAiService],
})
export class EditorAiModule {}
