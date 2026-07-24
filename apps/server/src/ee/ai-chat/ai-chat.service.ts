import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AiChatRepo } from '@akasha/db/repos/ai-chat/ai-chat.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { AiChat, User, Workspace } from '@akasha/db/types/entity.types';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { UserRole } from '../../common/helpers/types/permission';
import { AiKnowledgeChatService } from '../llm-wiki/services/ai-knowledge-chat.service';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import { createHash } from 'crypto';

export type AiChatStreamEvent =
  | { type: 'chat_created'; chatId: string }
  | { type: 'progress'; stage: 'permissions' | 'retrieval' | 'generation' }
  | { type: 'content'; text: string };

export type SendAiChatMessageInput = {
  workspace: Workspace;
  user: User;
  chatId?: string;
  content: string;
  mentionedPageIds?: string[];
  contextPageId?: string;
  attachmentIds?: string[];
  spaceIds?: string[];
  onEvent?: (event: AiChatStreamEvent) => void;
};

export type SendAiChatMessageResult = {
  chatId: string;
  assistantMessageId: string;
  answer: string;
  citations?: unknown[];
  citationEvidence?: unknown[];
  retrievedSources?: unknown[];
  retrievalDiagnostics?: unknown;
  retrievalReasons?: string[];
  completenessNotice?: string;
  answerMode?: 'knowledge' | 'no_match';
};

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    private readonly aiChatRepo: AiChatRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly knowledgeChat: AiKnowledgeChatService,
    private readonly queryAuditRepo: KnowledgeQueryAuditRepo,
    @Optional() private readonly attachmentRepo?: AttachmentRepo,
  ) {}

  async createChat(input: { workspaceId: string; userId: string }) {
    return this.aiChatRepo.createChat({
      workspaceId: input.workspaceId,
      creatorId: input.userId,
      title: null,
    });
  }

  async listChats(input: {
    workspaceId: string;
    userId: string;
    pagination: PaginationOptions;
  }) {
    return this.aiChatRepo.listChats(input);
  }

  async getChatInfo(input: {
    workspaceId: string;
    userId: string;
    chatId: string;
  }) {
    const chat = await this.getOwnedChat(input);
    const messages = await this.aiChatRepo.findMessages({
      workspaceId: input.workspaceId,
      chatId: input.chatId,
    });

    return { chat, messages };
  }

  async deleteChat(input: {
    workspaceId: string;
    userId: string;
    chatId: string;
  }): Promise<void> {
    await this.getOwnedChat(input);
    await this.aiChatRepo.softDeleteChat(input);
  }

  async updateChatTitle(input: {
    workspaceId: string;
    userId: string;
    chatId: string;
    title: string;
  }): Promise<void> {
    await this.getOwnedChat(input);
    await this.aiChatRepo.updateChatTitle(input);
  }

  async searchChats(input: {
    workspaceId: string;
    userId: string;
    query: string;
  }) {
    return this.aiChatRepo.searchChats(input);
  }

  async sendMessage(
    input: SendAiChatMessageInput,
  ): Promise<SendAiChatMessageResult> {
    const content = input.content.trim();
    if (!content && !input.attachmentIds?.length) {
      throw new BadRequestException('Message content is required');
    }

    const chat = input.chatId
      ? await this.getOwnedChat({
          workspaceId: input.workspace.id,
          userId: input.user.id,
          chatId: input.chatId,
        })
      : await this.aiChatRepo.createChat({
          workspaceId: input.workspace.id,
          creatorId: input.user.id,
          title: buildTitle(content),
        });
    input.onEvent?.({ type: 'chat_created', chatId: chat.id });

    if (input.attachmentIds?.length && this.attachmentRepo) {
      await this.attachmentRepo.claimAttachmentsForChat(
        input.attachmentIds,
        chat.id,
        input.user.id,
        input.workspace.id,
      );
    }

    const previousMessages = input.chatId
      ? await this.aiChatRepo.findMessages({
          workspaceId: input.workspace.id,
          chatId: chat.id,
          limit: 20,
        })
      : [];

    input.onEvent?.({ type: 'progress', stage: 'permissions' });
    const readableSpaceIds = await this.getDefaultReadableSpaceIds({
      workspaceId: input.workspace.id,
      user: input.user,
    });
    const spaceIds = resolveRequestedSpaceIds(input.spaceIds, readableSpaceIds);

    await this.aiChatRepo.addMessage({
      workspaceId: input.workspace.id,
      chatId: chat.id,
      userId: input.user.id,
      role: 'user',
      content,
      toolCalls: null,
      metadata: buildUserMetadata(input, spaceIds) as never,
    });

    input.onEvent?.({ type: 'progress', stage: 'retrieval' });
    const answer = await this.knowledgeChat.chat({
      workspaceId: input.workspace.id,
      userId: input.user.id,
      query: content,
      spaceIds,
      chatContext: previousMessages
        .filter((message) => message.content)
        .slice(-8)
        .map((message) => `${message.role}: ${message.content}`),
      workspace: input.workspace,
      mentionedPageIds: input.mentionedPageIds,
      contextPageId: input.contextPageId,
      attachmentIds: input.attachmentIds,
      onToken: (text) => input.onEvent?.({ type: 'content', text }),
      onStage: (stage) => input.onEvent?.({ type: 'progress', stage }),
    });

    const assistantMessage = await this.aiChatRepo.addMessage({
      workspaceId: input.workspace.id,
      chatId: chat.id,
      userId: null,
      role: 'assistant',
      content: answer.answer,
      toolCalls: null,
      metadata: {
        citations: answer.citations,
        citationEvidence: answer.citationEvidence,
        retrievedSources: answer.retrievedSources,
        retrievalDiagnostics: answer.retrievalDiagnostics,
        retrievalReasons: answer.retrievalReasons,
        completenessNotice: answer.completenessNotice,
        answerMode: answer.answerMode,
        spaceIds,
      } as never,
    });

    await this.recordQueryAudit({
      workspaceId: input.workspace.id,
      userId: input.user.id,
      query: content,
      spaceIds,
      answerMode: answer.answerMode,
      citationCount: answer.citations.length,
      retrievedSourceCount: answer.retrievedSources.length,
      retrievalDiagnostics: answer.retrievalDiagnostics,
    });

    return {
      chatId: chat.id,
      assistantMessageId: assistantMessage.id,
      answer: answer.answer,
      citations: answer.citations,
      citationEvidence: answer.citationEvidence,
      retrievedSources: answer.retrievedSources,
      retrievalDiagnostics: answer.retrievalDiagnostics,
      retrievalReasons: answer.retrievalReasons,
      completenessNotice: answer.completenessNotice,
      answerMode: answer.answerMode,
    };
  }

  private async getOwnedChat(input: {
    workspaceId: string;
    userId: string;
    chatId: string;
  }): Promise<AiChat> {
    const chat = await this.aiChatRepo.findChatByIdForUser(input);
    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    return chat;
  }

  private async getDefaultReadableSpaceIds(input: {
    workspaceId: string;
    user: User;
  }): Promise<string[]> {
    if (input.user.role === UserRole.OWNER) {
      const spaces = await this.spaceRepo.getSpacesInWorkspace(
        input.workspaceId,
        {
          limit: 100,
        } as PaginationOptions,
      );
      return spaces.items.map((space) => space.id);
    }

    return this.spaceMemberRepo.getUserSpaceIds(input.user.id);
  }

  private async recordQueryAudit(input: {
    workspaceId: string;
    userId: string;
    query: string;
    spaceIds: string[];
    answerMode: 'knowledge' | 'no_match';
    citationCount: number;
    retrievedSourceCount: number;
    retrievalDiagnostics: {
      mode: string;
      queryEmbeddingAvailable: boolean;
      candidateSourceCount: number;
      policyCandidateSourceCount: number;
      fallbackCandidateSourceCount: number;
      finalAuthorizedSourceCount: number;
      accessPolicyFallbackUsed: boolean;
      candidateChunkCount: number;
      rankedCandidateCount: number;
      authorizedChunkCount: number;
      filteredChunkCount: number;
    };
  }): Promise<void> {
    const diagnostics = input.retrievalDiagnostics;
    if (!diagnostics) return;

    try {
      await this.queryAuditRepo.recordQuery({
        workspaceId: input.workspaceId,
        userId: input.userId,
        queryHash: `sha256:${createHash('sha256').update(input.query).digest('hex')}`,
        retrievalMode: diagnostics.mode,
        authorizedCapsuleCount: diagnostics.authorizedChunkCount,
        metadata: {
          origin: 'ai_qa',
          answerMode: input.answerMode,
          citationCount: input.citationCount,
          retrievedSourceCount: input.retrievedSourceCount,
          spaceIds: input.spaceIds,
          queryEmbeddingAvailable: diagnostics.queryEmbeddingAvailable,
          candidateSourceCount: diagnostics.candidateSourceCount,
          policyCandidateSourceCount: diagnostics.policyCandidateSourceCount,
          fallbackCandidateSourceCount:
            diagnostics.fallbackCandidateSourceCount,
          finalAuthorizedSourceCount: diagnostics.finalAuthorizedSourceCount,
          accessPolicyFallbackUsed: diagnostics.accessPolicyFallbackUsed,
          candidateChunkCount: diagnostics.candidateChunkCount,
          rankedCandidateCount: diagnostics.rankedCandidateCount,
          authorizedChunkCount: diagnostics.authorizedChunkCount,
          filteredChunkCount: diagnostics.filteredChunkCount,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to record AI Q&A retrieval audit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function buildTitle(content: string): string {
  const title = content.replace(/\s+/g, ' ').trim();
  return title.length > 60
    ? `${title.slice(0, 57)}...`
    : title || 'New question';
}

function buildUserMetadata(input: SendAiChatMessageInput, spaceIds: string[]) {
  const metadata: Record<string, unknown> = {};
  metadata.spaceIds = spaceIds;
  if (input.mentionedPageIds?.length) {
    metadata.mentionedPageIds = input.mentionedPageIds;
  }
  if (input.contextPageId) {
    metadata.contextPageId = input.contextPageId;
  }
  if (input.attachmentIds?.length) {
    metadata.attachmentIds = input.attachmentIds;
  }

  return metadata;
}

function resolveRequestedSpaceIds(
  requestedSpaceIds: string[] | undefined,
  readableSpaceIds: string[],
): string[] {
  const readable = new Set(readableSpaceIds);
  const requested = requestedSpaceIds ?? readableSpaceIds;
  return [...new Set(requested)].filter((spaceId) => readable.has(spaceId));
}
