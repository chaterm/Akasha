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
import {
  AiChat,
  AiChatMessage,
  User,
  Workspace,
} from '@akasha/db/types/entity.types';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { UserRole } from '../../common/helpers/types/permission';
import {
  AiKnowledgeChatService,
  type AiChatThinkingEvent,
  isGeneralKnowledgeEnabledForUser,
} from '../llm-wiki/services/ai-knowledge-chat.service';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import { createHash } from 'crypto';
import {
  AiChatDebugTiming,
  measureAiChatPhase,
} from '../../common/observability/ai-chat-debug-timing';

export type AiChatStreamEvent =
  | { type: 'chat_created'; chatId: string }
  | {
      type: 'message_edited';
      chatId: string;
      messageId: string;
      content: string;
    }
  | {
      type: 'progress';
      stage: 'permissions' | 'understanding' | 'retrieval' | 'generation';
    }
  | ({ type: 'thinking' } & AiChatThinkingEvent)
  | { type: 'content'; text: string }
  | { type: 'superseded'; chatId: string };

export type SendAiChatMessageInput = {
  workspace: Workspace;
  user: User;
  chatId?: string;
  content: string;
  mentionedPageIds?: string[];
  contextPageId?: string;
  attachmentIds?: string[];
  spaceIds?: string[];
  responseMode?: 'knowledge' | 'general';
  onEvent?: (event: AiChatStreamEvent) => void;
};

export type EditAiChatMessageInput = {
  workspace: Workspace;
  user: User;
  chatId: string;
  messageId: string;
  content: string;
  onEvent?: (event: AiChatStreamEvent) => void;
};

export type SendAiChatMessageResult = {
  chatId: string;
  userMessageId?: string;
  assistantMessageId?: string;
  answer?: string;
  superseded?: boolean;
  citations?: unknown[];
  citationEvidence?: unknown[];
  retrievedSources?: unknown[];
  retrievalDiagnostics?: unknown;
  retrievalReasons?: string[];
  completenessNotice?: string;
  answerMode?: 'knowledge' | 'no_match' | 'general';
  retrievalQuery?: string;
  canExpandScope?: boolean;
  thinkingTrace?: AiChatThinkingEvent[];
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

    const debugTiming = AiChatDebugTiming.create(this.logger, {
      workspaceId: input.workspace.id,
      operation: 'send',
    });
    const chat = await measureAiChatPhase(
      debugTiming,
      'request.chat',
      () =>
        input.chatId
          ? this.getOwnedChat({
              workspaceId: input.workspace.id,
              userId: input.user.id,
              chatId: input.chatId,
            })
          : this.aiChatRepo.createChat({
              workspaceId: input.workspace.id,
              creatorId: input.user.id,
              title: buildTitle(content),
            }),
      { existingChat: Boolean(input.chatId) },
    );
    debugTiming?.setChatId(chat.id);
    input.onEvent?.({ type: 'chat_created', chatId: chat.id });

    if (input.attachmentIds?.length && this.attachmentRepo) {
      await measureAiChatPhase(
        debugTiming,
        'request.claim_attachments',
        () =>
          this.attachmentRepo!.claimAttachmentsForChat(
            input.attachmentIds!,
            chat.id,
            input.user.id,
            input.workspace.id,
          ),
        { attachmentCount: input.attachmentIds.length },
      );
    }

    const previousMessages = await measureAiChatPhase(
      debugTiming,
      'request.load_history',
      () =>
        input.chatId
          ? this.aiChatRepo.findMessages({
              workspaceId: input.workspace.id,
              chatId: chat.id,
              limit: 20,
            })
          : Promise.resolve([]),
      (messages) => ({ historyMessageCount: messages.length }),
    );

    input.onEvent?.({ type: 'progress', stage: 'permissions' });
    const readableSpaceIds = await measureAiChatPhase(
      debugTiming,
      'request.resolve_spaces',
      () =>
        this.getDefaultReadableSpaceIds({
          workspaceId: input.workspace.id,
          user: input.user,
        }),
      (spaceIds) => ({ readableSpaceCount: spaceIds.length }),
    );
    const spaceIds = resolveRequestedSpaceIds(input.spaceIds, readableSpaceIds);

    const userMessage = await measureAiChatPhase(
      debugTiming,
      'request.persist_user_message',
      () =>
        this.aiChatRepo.addMessage({
          workspaceId: input.workspace.id,
          chatId: chat.id,
          userId: input.user.id,
          role: 'user',
          content,
          toolCalls: null,
          metadata: buildUserMetadata(input, spaceIds) as never,
        }),
      { selectedSpaceCount: spaceIds.length },
    );

    return this.generateAndPersistAnswer({
      workspace: input.workspace,
      user: input.user,
      chatId: chat.id,
      content,
      previousMessages,
      anchorMessage: userMessage,
      spaceIds,
      readableSpaceCount: readableSpaceIds.length,
      requestedSpaceIds: input.spaceIds,
      mentionedPageIds: input.mentionedPageIds,
      contextPageId: input.contextPageId,
      attachmentIds: input.attachmentIds,
      responseMode: input.responseMode,
      onEvent: input.onEvent,
      debugTiming,
    });
  }

  async editMessage(
    input: EditAiChatMessageInput,
  ): Promise<SendAiChatMessageResult> {
    const content = input.content.trim();
    if (!content) {
      throw new BadRequestException('Message content is required');
    }

    const debugTiming = AiChatDebugTiming.create(this.logger, {
      workspaceId: input.workspace.id,
      operation: 'edit',
    });
    debugTiming?.setChatId(input.chatId);
    const edit = await measureAiChatPhase(
      debugTiming,
      'request.edit_and_load_history',
      () =>
        this.aiChatRepo.editUserMessageAndSoftDeleteTail({
          workspaceId: input.workspace.id,
          userId: input.user.id,
          chatId: input.chatId,
          messageId: input.messageId,
          content,
        }),
      (result) => ({
        historyMessageCount: result?.previousMessages.length ?? 0,
      }),
    );
    if (!edit) {
      throw new NotFoundException('Message not found');
    }

    input.onEvent?.({
      type: 'message_edited',
      chatId: input.chatId,
      messageId: input.messageId,
      content,
    });
    input.onEvent?.({ type: 'progress', stage: 'permissions' });

    const storedContext = readStoredUserContext(edit.message.metadata);
    const readableSpaceIds = await measureAiChatPhase(
      debugTiming,
      'request.resolve_spaces',
      () =>
        this.getDefaultReadableSpaceIds({
          workspaceId: input.workspace.id,
          user: input.user,
        }),
      (spaceIds) => ({ readableSpaceCount: spaceIds.length }),
    );
    const spaceIds = resolveRequestedSpaceIds(
      storedContext.spaceIds,
      readableSpaceIds,
    );

    return this.generateAndPersistAnswer({
      workspace: input.workspace,
      user: input.user,
      chatId: input.chatId,
      content,
      previousMessages: edit.previousMessages,
      anchorMessage: edit.message,
      spaceIds,
      readableSpaceCount: readableSpaceIds.length,
      requestedSpaceIds: storedContext.spaceIds,
      mentionedPageIds: storedContext.mentionedPageIds,
      contextPageId: storedContext.contextPageId,
      attachmentIds: storedContext.attachmentIds,
      responseMode: storedContext.responseMode,
      requireCurrentAnchor: true,
      onEvent: input.onEvent,
      debugTiming,
    });
  }

  private async generateAndPersistAnswer(input: {
    workspace: Workspace;
    user: User;
    chatId: string;
    content: string;
    previousMessages: AiChatMessage[];
    anchorMessage: AiChatMessage;
    spaceIds: string[];
    readableSpaceCount: number;
    requestedSpaceIds?: string[];
    mentionedPageIds?: string[];
    contextPageId?: string;
    attachmentIds?: string[];
    responseMode?: 'knowledge' | 'general';
    requireCurrentAnchor?: boolean;
    onEvent?: (event: AiChatStreamEvent) => void;
    debugTiming?: AiChatDebugTiming;
  }): Promise<SendAiChatMessageResult> {
    const canExpandScope =
      Boolean(input.requestedSpaceIds?.length) &&
      input.spaceIds.length < input.readableSpaceCount;

    const chatContext = input.previousMessages
      .filter((message) => message.content)
      .slice(-15)
      .map((message) => `${message.role}: ${message.content}`);
    const thinkingTrace: AiChatThinkingEvent[] = [];
    const answer = await measureAiChatPhase(
      input.debugTiming,
      'knowledge.total',
      () =>
        this.knowledgeChat.chat({
          workspaceId: input.workspace.id,
          userId: input.user.id,
          chatId: input.chatId,
          query: input.content,
          spaceIds: input.spaceIds,
          chatContext,
          workspace: input.workspace,
          mentionedPageIds: input.mentionedPageIds,
          contextPageId: input.contextPageId,
          attachmentIds: input.attachmentIds,
          responseMode: input.responseMode,
          ...(isGeneralKnowledgeEnabledForUser(input.user)
            ? {}
            : { generalKnowledgeEnabled: false }),
          onToken: (text) => {
            if (text) {
              input.debugTiming?.markFirstContent({ source: 'answer' });
            }
            input.onEvent?.({ type: 'content', text });
          },
          onStage: (stage) => {
            input.debugTiming?.mark('knowledge.stage', { stage });
            input.onEvent?.({ type: 'progress', stage });
          },
          onThinking: (event) => {
            upsertThinkingTrace(thinkingTrace, event);
            input.onEvent?.({ type: 'thinking', ...event });
          },
          ...(input.debugTiming ? { debugTiming: input.debugTiming } : {}),
        }),
      {
        historyMessageCount: chatContext.length,
        selectedSpaceCount: input.spaceIds.length,
        responseMode: input.responseMode ?? 'knowledge',
      },
    );

    const assistantMetadata = {
      citations: answer.citations,
      citationEvidence: answer.citationEvidence,
      retrievedSources: answer.retrievedSources,
      retrievalDiagnostics: answer.retrievalDiagnostics,
      retrievalReasons: answer.retrievalReasons,
      completenessNotice: answer.completenessNotice,
      answerMode: answer.answerMode,
      ...(answer.retrievalQuery
        ? { retrievalQuery: answer.retrievalQuery }
        : {}),
      ...(answer.answerMode === 'no_match' ? { canExpandScope } : {}),
      ...(thinkingTrace.length ? { thinkingTrace } : {}),
      spaceIds: input.spaceIds,
    } as never;
    const assistantMessage = await measureAiChatPhase(
      input.debugTiming,
      'response.persist_assistant_message',
      () =>
        input.requireCurrentAnchor
          ? this.aiChatRepo.addAssistantMessageIfCurrent({
              workspaceId: input.workspace.id,
              userId: input.user.id,
              chatId: input.chatId,
              anchorMessageId: input.anchorMessage.id,
              anchorUpdatedAt: input.anchorMessage.updatedAt,
              content: answer.answer,
              metadata: assistantMetadata,
            })
          : this.aiChatRepo.addMessage({
              workspaceId: input.workspace.id,
              chatId: input.chatId,
              userId: null,
              role: 'assistant',
              content: answer.answer,
              toolCalls: null,
              metadata: assistantMetadata,
            }),
    );
    if (!assistantMessage) {
      input.onEvent?.({ type: 'superseded', chatId: input.chatId });
      input.debugTiming?.complete({ status: 'superseded' });
      return { chatId: input.chatId, superseded: true };
    }

    await measureAiChatPhase(input.debugTiming, 'response.record_audit', () =>
      this.recordQueryAudit({
        workspaceId: input.workspace.id,
        userId: input.user.id,
        query: input.content,
        spaceIds: input.spaceIds,
        answerMode: answer.answerMode,
        citationCount: answer.citations.length,
        retrievedSourceCount: answer.retrievedSources.length,
        retrievalDiagnostics: answer.retrievalDiagnostics,
        snippets: answer.snippets ?? [],
        trustedCitationIds: answer.citations.map(
          (citation) => citation.sourcePageId,
        ),
      }),
    );
    input.debugTiming?.complete({
      status: 'ok',
      answerMode: answer.answerMode,
      citationCount: answer.citations.length,
      retrievedSourceCount: answer.retrievedSources.length,
    });

    return {
      chatId: input.chatId,
      userMessageId: input.anchorMessage.id,
      assistantMessageId: assistantMessage.id,
      answer: answer.answer,
      citations: answer.citations,
      citationEvidence: answer.citationEvidence,
      retrievedSources: answer.retrievedSources,
      retrievalDiagnostics: answer.retrievalDiagnostics,
      retrievalReasons: answer.retrievalReasons,
      completenessNotice: answer.completenessNotice,
      answerMode: answer.answerMode,
      ...(answer.retrievalQuery
        ? { retrievalQuery: answer.retrievalQuery }
        : {}),
      ...(answer.answerMode === 'no_match' ? { canExpandScope } : {}),
      ...(thinkingTrace.length ? { thinkingTrace } : {}),
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
      const spaceIds: string[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      while (true) {
        const spaces = await this.spaceRepo.getSpacesInWorkspace(
          input.workspaceId,
          {
            limit: 100,
            ...(cursor ? { cursor } : {}),
          } as PaginationOptions,
        );
        spaceIds.push(...spaces.items.map((space) => space.id));
        const nextCursor = spaces.meta?.nextCursor ?? null;
        if (!spaces.meta?.hasNextPage || !nextCursor) break;
        if (seenCursors.has(nextCursor)) {
          this.logger.warn(
            'Stopped owner space pagination because the cursor repeated.',
          );
          break;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      return [...new Set(spaceIds)];
    }

    return this.spaceMemberRepo.getUserSpaceIds(input.user.id);
  }

  private async recordQueryAudit(input: {
    workspaceId: string;
    userId: string;
    query: string;
    spaceIds: string[];
    answerMode: 'knowledge' | 'no_match' | 'general';
    citationCount: number;
    retrievedSourceCount: number;
    snippets: Array<{
      id: string;
      retrievalReasons: string[];
      sourceWindows: Array<{
        sourcePageId: string;
        sourceRange: { startOffset: number; endOffset: number };
        quoteHash: string;
      }>;
    }>;
    trustedCitationIds: string[];
    retrievalDiagnostics?: {
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
          finalChunkIds: input.snippets.map((snippet) => snippet.id),
          finalSourcePageIds: [
            ...new Set(
              input.snippets.flatMap((snippet) =>
                snippet.sourceWindows.map((window) => window.sourcePageId),
              ),
            ),
          ],
          trustedCitationIds: [...new Set(input.trustedCitationIds)],
          rankReasonsByChunk: Object.fromEntries(
            input.snippets.map((snippet) => [
              snippet.id,
              snippet.retrievalReasons,
            ]),
          ),
          evidenceRefs: input.snippets.flatMap((snippet) =>
            snippet.sourceWindows.map((window) => ({
              sourcePageId: window.sourcePageId,
              sourceRange: window.sourceRange,
              quoteHash: window.quoteHash,
            })),
          ),
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
  if (input.responseMode) {
    metadata.responseMode = input.responseMode;
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

function readStoredUserContext(metadata: AiChatMessage['metadata']): {
  spaceIds?: string[];
  mentionedPageIds?: string[];
  contextPageId?: string;
  attachmentIds?: string[];
  responseMode?: 'knowledge' | 'general';
} {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const record = metadata as Record<string, unknown>;
  return {
    spaceIds: readStringArray(record.spaceIds),
    mentionedPageIds: readStringArray(record.mentionedPageIds),
    contextPageId:
      typeof record.contextPageId === 'string'
        ? record.contextPageId
        : undefined,
    attachmentIds: readStringArray(record.attachmentIds),
    responseMode:
      record.responseMode === 'knowledge' || record.responseMode === 'general'
        ? record.responseMode
        : undefined,
  };
}

function upsertThinkingTrace(
  trace: AiChatThinkingEvent[],
  event: AiChatThinkingEvent,
): void {
  const existingIndex = trace.findIndex((item) => item.step === event.step);
  if (existingIndex < 0) {
    trace.push({ ...event });
    return;
  }

  const existing = trace[existingIndex];
  trace[existingIndex] = {
    ...existing,
    ...event,
    ...((existing.stats || event.stats) && {
      stats: { ...existing.stats, ...event.stats },
    }),
  };
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}
