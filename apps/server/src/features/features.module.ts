import { Module } from '@nestjs/common';
import { LlmWikiModule } from './llm-wiki/llm-wiki.module';
import { AiChatModule } from './ai-chat/ai-chat.module';
import { DocumentImportModule } from './document-import/document-import.module';
import { ConfluenceImportModule } from './confluence-import/confluence-import.module';
import { EditorAiModule } from './editor-ai/editor-ai.module';
import { ApiKeyModule } from './api-key/api-key.module';
import { CronModule } from './cron/cron.module';

@Module({
  imports: [
    LlmWikiModule,
    AiChatModule,
    DocumentImportModule,
    ConfluenceImportModule,
    EditorAiModule,
    ApiKeyModule,
    CronModule,
  ],
})
export class FeaturesModule {}
