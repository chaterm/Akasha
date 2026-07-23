import { Module } from '@nestjs/common';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { LlmWikiModule } from '../llm-wiki/llm-wiki.module';

@Module({
  imports: [LlmWikiModule],
  controllers: [AiChatController],
  providers: [AiChatService],
})
export class AiChatModule {}
