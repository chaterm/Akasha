import { AiChatService } from './ai-chat.service';
import { AiChatRepo } from '@akasha/db/repos/ai-chat/ai-chat.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { AiKnowledgeChatService } from '../llm-wiki/services/ai-knowledge-chat.service';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';

describe('AiChatService', () => {
  it('limits selected spaces to readable spaces, stores evidence, and records retrieval audit', async () => {
    const repo = {
      createChat: jest.fn().mockResolvedValue(chat('chat-1')),
      addMessage: jest
        .fn()
        .mockResolvedValueOnce(message('message-user-1', 'user', 'hello'))
        .mockResolvedValueOnce(
          message('message-assistant-1', 'assistant', 'answer'),
        ),
      addAssistantMessageIfCurrent: jest
        .fn()
        .mockResolvedValue(
          message('message-assistant-1', 'assistant', 'answer'),
        ),
      findMessages: jest.fn(),
    };
    const spaceRepo = {
      getSpacesInWorkspace: jest.fn().mockResolvedValue({
        items: [{ id: 'space-1' }, { id: 'space-2' }],
      }),
    };
    const spaceMemberRepo = {
      getUserSpaceIds: jest.fn(),
    };
    const knowledgeChat = {
      chat: jest.fn().mockResolvedValue({
        answer: 'answer',
        answerMode: 'knowledge',
        citations: [
          { sourcePageId: 'page-1', title: 'Page', url: '/p/page-1' },
        ],
        citationEvidence: [
          {
            sourcePageId: 'page-1',
            title: 'Page',
            url: '/p/page-1',
            excerpts: [
              {
                text: 'Verified excerpt',
                sourceRange: { startOffset: 10, endOffset: 26 },
                quoteHash: 'sha256:verified',
              },
            ],
          },
        ],
        retrievedSources: [
          { sourcePageId: 'page-1', title: 'Page', url: '/p/page-1' },
          { sourcePageId: 'page-2', title: 'Other', url: '/p/page-2' },
        ],
        snippets: [
          {
            id: 'chunk-1',
            title: 'Page',
            text: 'Verified excerpt',
            retrievalReasons: ['lexical'],
            sourceWindows: [
              {
                sourcePageId: 'page-1',
                title: 'Page',
                url: '/p/page-1',
                text: 'Verified excerpt',
                sourceRange: { startOffset: 10, endOffset: 26 },
                quoteHash: 'sha256:verified',
              },
            ],
          },
        ],
        retrievalReasons: ['lexical'],
        completenessNotice: 'notice',
        retrievalDiagnostics: diagnostics(),
        retrievalQuery: 'rewritten hello',
      }),
    };
    const queryAuditRepo = {
      recordQuery: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AiChatService(
      repo as unknown as AiChatRepo,
      spaceRepo as unknown as SpaceRepo,
      spaceMemberRepo as unknown as SpaceMemberRepo,
      knowledgeChat as unknown as AiKnowledgeChatService,
      queryAuditRepo as unknown as KnowledgeQueryAuditRepo,
    );

    await expect(
      service.sendMessage({
        workspace: workspace() as never,
        user: user('owner') as never,
        content: 'hello',
        spaceIds: ['space-2', 'space-hidden', 'space-2'],
      }),
    ).resolves.toEqual({
      chatId: 'chat-1',
      assistantMessageId: 'message-assistant-1',
      answer: 'answer',
      citations: [{ sourcePageId: 'page-1', title: 'Page', url: '/p/page-1' }],
      citationEvidence: [
        {
          sourcePageId: 'page-1',
          title: 'Page',
          url: '/p/page-1',
          excerpts: [
            {
              text: 'Verified excerpt',
              sourceRange: { startOffset: 10, endOffset: 26 },
              quoteHash: 'sha256:verified',
            },
          ],
        },
      ],
      retrievedSources: [
        { sourcePageId: 'page-1', title: 'Page', url: '/p/page-1' },
        { sourcePageId: 'page-2', title: 'Other', url: '/p/page-2' },
      ],
      retrievalDiagnostics: diagnostics(),
      retrievalReasons: ['lexical'],
      completenessNotice: 'notice',
      answerMode: 'knowledge',
      retrievalQuery: 'rewritten hello',
    });

    expect(repo.createChat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      creatorId: 'user-1',
      title: 'hello',
    });
    expect(knowledgeChat.chat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'hello',
      spaceIds: ['space-2'],
      chatContext: [],
      workspace: workspace(),
      mentionedPageIds: undefined,
      contextPageId: undefined,
      attachmentIds: undefined,
      onToken: expect.any(Function),
      onStage: expect.any(Function),
    });
    expect(repo.addMessage).toHaveBeenNthCalledWith(1, {
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      userId: 'user-1',
      role: 'user',
      content: 'hello',
      toolCalls: null,
      metadata: { spaceIds: ['space-2'] },
    });
    expect(repo.addMessage).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      userId: null,
      role: 'assistant',
      content: 'answer',
      toolCalls: null,
      metadata: {
        citations: [
          { sourcePageId: 'page-1', title: 'Page', url: '/p/page-1' },
        ],
        citationEvidence: [
          {
            sourcePageId: 'page-1',
            title: 'Page',
            url: '/p/page-1',
            excerpts: [
              {
                text: 'Verified excerpt',
                sourceRange: { startOffset: 10, endOffset: 26 },
                quoteHash: 'sha256:verified',
              },
            ],
          },
        ],
        retrievedSources: [
          { sourcePageId: 'page-1', title: 'Page', url: '/p/page-1' },
          { sourcePageId: 'page-2', title: 'Other', url: '/p/page-2' },
        ],
        retrievalDiagnostics: diagnostics(),
        retrievalReasons: ['lexical'],
        completenessNotice: 'notice',
        answerMode: 'knowledge',
        retrievalQuery: 'rewritten hello',
        spaceIds: ['space-2'],
      },
    });
    expect(repo.addAssistantMessageIfCurrent).not.toHaveBeenCalled();
    expect(queryAuditRepo.recordQuery).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      queryHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      retrievalMode: 'high_completeness',
      authorizedCapsuleCount: 1,
      metadata: expect.objectContaining({
        origin: 'ai_qa',
        answerMode: 'knowledge',
        citationCount: 1,
        retrievedSourceCount: 2,
        spaceIds: ['space-2'],
        queryEmbeddingAvailable: true,
        authorizedChunkCount: 1,
        finalChunkIds: ['chunk-1'],
        finalSourcePageIds: ['page-1'],
        trustedCitationIds: ['page-1'],
        rankReasonsByChunk: {
          'chunk-1': ['lexical'],
        },
        evidenceRefs: [
          {
            sourcePageId: 'page-1',
            sourceRange: { startOffset: 10, endOffset: 26 },
            quoteHash: 'sha256:verified',
          },
        ],
      }),
    });
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
  });

  it('passes the latest 15 non-empty messages as multi-turn chat context', async () => {
    const previousMessages = Array.from({ length: 18 }, (_, index) =>
      message(
        `previous-${index + 1}`,
        index % 2 === 0 ? 'user' : 'assistant',
        `turn-${index + 1}`,
      ),
    );
    const repo = {
      findChatByIdForUser: jest.fn().mockResolvedValue(chat('chat-1')),
      findMessages: jest.fn().mockResolvedValue(previousMessages),
      addMessage: jest
        .fn()
        .mockResolvedValueOnce(message('message-user-1', 'user', 'follow-up'))
        .mockResolvedValueOnce(
          message('message-assistant-1', 'assistant', 'answer'),
        ),
      addAssistantMessageIfCurrent: jest
        .fn()
        .mockResolvedValue(
          message('message-assistant-1', 'assistant', 'answer'),
        ),
    };
    const spaceRepo = {
      getSpacesInWorkspace: jest.fn().mockResolvedValue({
        items: [{ id: 'space-1' }],
      }),
    };
    const knowledgeChat = {
      chat: jest.fn().mockResolvedValue({
        answer: 'answer',
        answerMode: 'knowledge',
        citations: [],
        citationEvidence: [],
        retrievedSources: [],
        snippets: [],
        retrievalReasons: [],
        retrievalDiagnostics: undefined,
      }),
    };
    const service = new AiChatService(
      repo as unknown as AiChatRepo,
      spaceRepo as unknown as SpaceRepo,
      {} as SpaceMemberRepo,
      knowledgeChat as unknown as AiKnowledgeChatService,
      {} as KnowledgeQueryAuditRepo,
    );

    await service.sendMessage({
      workspace: workspace() as never,
      user: user('owner') as never,
      chatId: 'chat-1',
      content: 'follow-up',
    });

    expect(repo.findMessages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      limit: 20,
    });
    expect(knowledgeChat.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatContext: previousMessages
          .slice(-15)
          .map((item) => `${item.role}: ${item.content}`),
      }),
    );
  });

  it('edits a user question, retains its context metadata, and regenerates from the active prefix', async () => {
    const anchorUpdatedAt = new Date('2026-07-30T08:05:00.000Z');
    const editedMessage = {
      ...message('message-user-2', 'user', 'edited question'),
      updatedAt: anchorUpdatedAt,
      metadata: {
        spaceIds: ['space-1', 'space-hidden'],
        mentionedPageIds: ['page-mentioned'],
        contextPageId: 'page-context',
        attachmentIds: ['attachment-1'],
        responseMode: 'general',
      },
    };
    const previousMessages = [
      message('message-user-1', 'user', 'first question'),
      message('message-assistant-1', 'assistant', 'first answer'),
    ];
    const assistantMessage = message(
      'message-assistant-2',
      'assistant',
      'new answer',
    );
    const repo = {
      editUserMessageAndSoftDeleteTail: jest.fn().mockResolvedValue({
        message: editedMessage,
        previousMessages,
      }),
      addAssistantMessageIfCurrent: jest
        .fn()
        .mockResolvedValue(assistantMessage),
      addMessage: jest.fn(),
    };
    const spaceRepo = {
      getSpacesInWorkspace: jest.fn().mockResolvedValue({
        items: [{ id: 'space-1' }, { id: 'space-2' }],
      }),
    };
    const knowledgeChat = {
      chat: jest.fn().mockResolvedValue({
        answer: 'new answer',
        answerMode: 'general',
        citations: [],
        citationEvidence: [],
        retrievedSources: [],
        snippets: [],
        retrievalReasons: [],
        retrievalDiagnostics: undefined,
      }),
    };
    const onEvent = jest.fn();
    const service = new AiChatService(
      repo as unknown as AiChatRepo,
      spaceRepo as unknown as SpaceRepo,
      {} as SpaceMemberRepo,
      knowledgeChat as unknown as AiKnowledgeChatService,
      {} as KnowledgeQueryAuditRepo,
    );

    const result = await (
      service as AiChatService & {
        editMessage(input: Record<string, unknown>): Promise<unknown>;
      }
    ).editMessage({
      workspace: workspace(),
      user: user('owner'),
      chatId: 'chat-1',
      messageId: 'message-user-2',
      content: ' edited question ',
      onEvent,
    });

    expect(repo.editUserMessageAndSoftDeleteTail).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      chatId: 'chat-1',
      messageId: 'message-user-2',
      content: 'edited question',
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'message_edited',
      chatId: 'chat-1',
      messageId: 'message-user-2',
      content: 'edited question',
    });
    expect(knowledgeChat.chat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'edited question',
      spaceIds: ['space-1'],
      chatContext: ['user: first question', 'assistant: first answer'],
      workspace: workspace(),
      mentionedPageIds: ['page-mentioned'],
      contextPageId: 'page-context',
      attachmentIds: ['attachment-1'],
      responseMode: 'general',
      onToken: expect.any(Function),
      onStage: expect.any(Function),
    });
    expect(repo.addMessage).not.toHaveBeenCalled();
    expect(repo.addAssistantMessageIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        chatId: 'chat-1',
        anchorMessageId: 'message-user-2',
        anchorUpdatedAt,
        content: 'new answer',
      }),
    );
    expect(
      repo.addAssistantMessageIfCurrent.mock.calls[0][0],
    ).not.toHaveProperty('replaceActiveTail');
    expect(result).toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        assistantMessageId: 'message-assistant-2',
        answer: 'new answer',
        answerMode: 'general',
      }),
    );
  });

  it('drops a superseded generated answer without persisting or auditing it', async () => {
    const repo = {
      editUserMessageAndSoftDeleteTail: jest.fn().mockResolvedValue({
        message: message('message-user-2', 'user', 'edited question'),
        previousMessages: [],
      }),
      addAssistantMessageIfCurrent: jest.fn().mockResolvedValue(null),
    };
    const spaceRepo = {
      getSpacesInWorkspace: jest.fn().mockResolvedValue({
        items: [{ id: 'space-1' }],
      }),
    };
    const knowledgeChat = {
      chat: jest.fn().mockResolvedValue({
        answer: 'stale answer',
        answerMode: 'knowledge',
        citations: [],
        citationEvidence: [],
        retrievedSources: [],
        snippets: [],
        retrievalReasons: [],
        retrievalDiagnostics: diagnostics(),
      }),
    };
    const queryAuditRepo = { recordQuery: jest.fn() };
    const onEvent = jest.fn();
    const service = new AiChatService(
      repo as unknown as AiChatRepo,
      spaceRepo as unknown as SpaceRepo,
      {} as SpaceMemberRepo,
      knowledgeChat as unknown as AiKnowledgeChatService,
      queryAuditRepo as unknown as KnowledgeQueryAuditRepo,
    );

    await expect(
      service.editMessage({
        workspace: workspace() as never,
        user: user('owner') as never,
        chatId: 'chat-1',
        messageId: 'message-user-2',
        content: 'edited question',
        onEvent,
      }),
    ).resolves.toEqual({ chatId: 'chat-1', superseded: true });

    expect(onEvent).toHaveBeenCalledWith({
      type: 'superseded',
      chatId: 'chat-1',
    });
    expect(queryAuditRepo.recordQuery).not.toHaveBeenCalled();
  });

  it('rejects an edit when the owned active user message is not found', async () => {
    const repo = {
      editUserMessageAndSoftDeleteTail: jest.fn().mockResolvedValue(null),
    };
    const knowledgeChat = { chat: jest.fn() };
    const service = new AiChatService(
      repo as unknown as AiChatRepo,
      {} as SpaceRepo,
      {} as SpaceMemberRepo,
      knowledgeChat as unknown as AiKnowledgeChatService,
      {} as KnowledgeQueryAuditRepo,
    );

    await expect(
      service.editMessage({
        workspace: workspace() as never,
        user: user('owner') as never,
        chatId: 'chat-1',
        messageId: 'foreign-message',
        content: 'edited question',
      }),
    ).rejects.toThrow('Message not found');
    expect(knowledgeChat.chat).not.toHaveBeenCalled();
  });

  it('marks a scoped no-match as eligible for an all-space retry', async () => {
    const repo = {
      createChat: jest.fn().mockResolvedValue(chat('chat-1')),
      addMessage: jest
        .fn()
        .mockResolvedValueOnce(message('message-user-1', 'user', 'weather'))
        .mockResolvedValueOnce(
          message('message-assistant-1', 'assistant', 'No knowledge'),
        ),
      addAssistantMessageIfCurrent: jest
        .fn()
        .mockResolvedValue(
          message('message-assistant-1', 'assistant', 'No knowledge'),
        ),
    };
    const spaceRepo = {
      getSpacesInWorkspace: jest.fn().mockResolvedValue({
        items: [{ id: 'space-1' }, { id: 'space-2' }],
      }),
    };
    const knowledgeChat = {
      chat: jest.fn().mockResolvedValue({
        answer: 'No knowledge',
        answerMode: 'no_match',
        citations: [],
        citationEvidence: [],
        retrievedSources: [],
        snippets: [],
        retrievalReasons: [],
        retrievalDiagnostics: diagnostics(),
      }),
    };
    const service = new AiChatService(
      repo as unknown as AiChatRepo,
      spaceRepo as unknown as SpaceRepo,
      {} as SpaceMemberRepo,
      knowledgeChat as unknown as AiKnowledgeChatService,
      { recordQuery: jest.fn() } as unknown as KnowledgeQueryAuditRepo,
    );

    const result = await service.sendMessage({
      workspace: workspace() as never,
      user: user('owner') as never,
      content: 'weather',
      spaceIds: ['space-1'],
    });

    expect(result.canExpandScope).toBe(true);
    expect(repo.addMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        metadata: expect.objectContaining({ canExpandScope: true }),
      }),
    );
  });

  it('passes an explicit general-answer mode without marking scope expansion', async () => {
    const repo = {
      createChat: jest.fn().mockResolvedValue(chat('chat-1')),
      addMessage: jest
        .fn()
        .mockResolvedValueOnce(message('message-user-1', 'user', 'weather'))
        .mockResolvedValueOnce(
          message('message-assistant-1', 'assistant', 'General answer'),
        ),
      addAssistantMessageIfCurrent: jest
        .fn()
        .mockResolvedValue(
          message('message-assistant-1', 'assistant', 'General answer'),
        ),
    };
    const spaceRepo = {
      getSpacesInWorkspace: jest.fn().mockResolvedValue({
        items: [{ id: 'space-1' }],
      }),
    };
    const knowledgeChat = {
      chat: jest.fn().mockResolvedValue({
        answer: 'General answer',
        answerMode: 'general',
        citations: [],
        citationEvidence: [],
        retrievedSources: [],
        snippets: [],
        retrievalReasons: [],
        retrievalDiagnostics: undefined,
      }),
    };
    const service = new AiChatService(
      repo as unknown as AiChatRepo,
      spaceRepo as unknown as SpaceRepo,
      {} as SpaceMemberRepo,
      knowledgeChat as unknown as AiKnowledgeChatService,
      {} as KnowledgeQueryAuditRepo,
    );

    const result = await service.sendMessage({
      workspace: workspace() as never,
      user: user('owner') as never,
      content: 'weather',
      responseMode: 'general',
    });

    expect(knowledgeChat.chat).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: 'general' }),
    );
    expect(result.answerMode).toBe('general');
    expect(result.canExpandScope).toBeUndefined();
    expect(repo.addMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        metadata: expect.objectContaining({ responseMode: 'general' }),
      }),
    );
  });

  it('loads every owner-readable space page when the scope is all spaces', async () => {
    const spaceRepo = {
      getSpacesInWorkspace: jest
        .fn()
        .mockResolvedValueOnce({
          items: [{ id: 'space-1' }, { id: 'space-2' }],
          meta: {
            hasNextPage: true,
            nextCursor: 'cursor-2',
          },
        })
        .mockResolvedValueOnce({
          items: [{ id: 'space-3' }],
          meta: {
            hasNextPage: false,
            nextCursor: null,
          },
        }),
    };
    const service = new AiChatService(
      {} as AiChatRepo,
      spaceRepo as unknown as SpaceRepo,
      {} as SpaceMemberRepo,
      {} as AiKnowledgeChatService,
      {} as KnowledgeQueryAuditRepo,
    );

    await expect(
      (
        service as unknown as {
          getDefaultReadableSpaceIds(input: unknown): Promise<string[]>;
        }
      ).getDefaultReadableSpaceIds({
        workspaceId: 'workspace-1',
        user: user('owner'),
      }),
    ).resolves.toEqual(['space-1', 'space-2', 'space-3']);

    expect(spaceRepo.getSpacesInWorkspace).toHaveBeenNthCalledWith(
      1,
      'workspace-1',
      { limit: 100 },
    );
    expect(spaceRepo.getSpacesInWorkspace).toHaveBeenNthCalledWith(
      2,
      'workspace-1',
      { limit: 100, cursor: 'cursor-2' },
    );
  });
});

function diagnostics() {
  return {
    mode: 'high_completeness',
    queryEmbeddingAvailable: true,
    candidateSourceCount: 2,
    policyCandidateSourceCount: 2,
    fallbackCandidateSourceCount: 0,
    finalAuthorizedSourceCount: 1,
    accessPolicyFallbackUsed: false,
    candidateChunkCount: 1,
    rankedCandidateCount: 1,
    authorizedChunkCount: 1,
    filteredChunkCount: 0,
  };
}

function workspace() {
  return {
    id: 'workspace-1',
    settings: { ai: { chat: true } },
  };
}

function user(role: string) {
  return {
    id: 'user-1',
    workspaceId: 'workspace-1',
    role,
  };
}

function chat(id: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    creatorId: 'user-1',
    title: 'hello',
    createdAt: new Date('2026-06-17T00:00:00.000Z'),
    updatedAt: new Date('2026-06-17T00:00:00.000Z'),
    deletedAt: null,
  };
}

function message(id: string, role: string, content: string) {
  return {
    id,
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    userId: role === 'user' ? 'user-1' : null,
    role,
    content,
    toolCalls: null,
    metadata: null,
    createdAt: new Date('2026-06-17T00:00:00.000Z'),
    updatedAt: new Date('2026-06-17T00:00:00.000Z'),
    deletedAt: null,
  };
}
