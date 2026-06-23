import { Module } from '@nestjs/common';
import { SsoModule } from './sso/sso.module';
import { ApiKeyModule } from './api-key/api-key.module';
import { DocumentImportModule } from './document-import/document-import.module';
import { ConfluenceImportModule } from './confluence-import/confluence-import.module';
import { LlmWikiModule } from './llm-wiki/llm-wiki.module';
import { ReviewModule } from './llm-wiki/review/review.module';
import { AiChatModule } from './ai-chat/ai-chat.module';

@Module({
  imports: [
    SsoModule,
    ApiKeyModule,
    DocumentImportModule,
    ConfluenceImportModule,
    LlmWikiModule,
    ReviewModule,
    AiChatModule,
  ],
})
export class EeModule {}
