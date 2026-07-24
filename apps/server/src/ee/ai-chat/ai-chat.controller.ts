import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AiChatService } from './ai-chat.service';
import {
  ChatIdDto,
  ListAiChatsDto,
  SearchAiChatsDto,
  SendAiChatMessageDto,
  UpdateAiChatTitleDto,
} from './dto/ai-chat.dto';

@UseGuards(JwtAuthGuard)
@Controller('ai/chats')
export class AiChatController {
  constructor(private readonly aiChatService: AiChatService) {}

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.aiChatService.createChat({
      workspaceId: workspace.id,
      userId: user.id,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(
    @Body() dto: ListAiChatsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatService.listChats({
      workspaceId: workspace.id,
      userId: user.id,
      pagination: dto,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async info(
    @Body() dto: ChatIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatService.getChatInfo({
      workspaceId: workspace.id,
      userId: user.id,
      chatId: dto.chatId,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(
    @Body() dto: ChatIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.aiChatService.deleteChat({
      workspaceId: workspace.id,
      userId: user.id,
      chatId: dto.chatId,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(
    @Body() dto: UpdateAiChatTitleDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.aiChatService.updateChatTitle({
      workspaceId: workspace.id,
      userId: user.id,
      chatId: dto.chatId,
      title: dto.title,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('search')
  async search(
    @Body() dto: SearchAiChatsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiChatService.searchChats({
      workspaceId: workspace.id,
      userId: user.id,
      query: dto.query,
    });
  }

  @Post('send')
  async send(
    @Body() dto: SendAiChatMessageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: SseReply,
  ) {
    this.prepareSse(res);

    try {
      let chatCreatedEmitted = false;
      let contentEmitted = false;
      const result = await this.aiChatService.sendMessage({
        workspace,
        user,
        chatId: dto.chatId,
        content: dto.content,
        mentionedPageIds: dto.mentionedPageIds,
        contextPageId: dto.contextPageId,
        attachmentIds: dto.attachmentIds,
        spaceIds: dto.spaceIds,
        onEvent: (event) => {
          if (event.type === 'chat_created') chatCreatedEmitted = true;
          if (event.type === 'content') contentEmitted = true;
          writeSse(res, event);
        },
      });

      if (!chatCreatedEmitted) {
        writeSse(res, { type: 'chat_created', chatId: result.chatId });
      }
      if (!contentEmitted && result.answer) {
        writeSse(res, { type: 'content', text: result.answer });
      }
      writeSse(res, {
        type: 'done',
        messageId: result.assistantMessageId,
        citations: result.citations,
        citationEvidence: result.citationEvidence,
        retrievedSources: result.retrievedSources,
        retrievalDiagnostics: result.retrievalDiagnostics,
        retrievalReasons: result.retrievalReasons,
        completenessNotice: result.completenessNotice,
        answerMode: result.answerMode,
      });
      writeRaw(res, 'data: [DONE]\n\n');
    } catch (error) {
      writeSse(res, {
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to send chat message',
        retryable: false,
      });
    } finally {
      endSse(res);
    }
  }

  private prepareSse(res: SseReply) {
    const raw = getRawResponse(res);
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    raw.flushHeaders?.();
  }
}

type SseRawResponse = {
  setHeader: (name: string, value: string) => void;
  write: (payload: string) => void;
  end: () => void;
  flushHeaders?: () => void;
};

type SseReply = SseRawResponse | { raw: SseRawResponse };

function writeSse(res: SseReply, event: Record<string, unknown>) {
  writeRaw(res, `data: ${JSON.stringify(event)}\n\n`);
}

function writeRaw(res: SseReply, payload: string) {
  getRawResponse(res).write(payload);
}

function endSse(res: SseReply) {
  getRawResponse(res).end();
}

function getRawResponse(res: SseReply): SseRawResponse {
  return 'raw' in res ? res.raw : res;
}
