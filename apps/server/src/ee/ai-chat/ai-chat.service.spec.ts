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
        retrievalReasons: ['lexical'],
        completenessNotice: 'notice',
        retrievalDiagnostics: diagnostics(),
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
        spaceIds: ['space-2'],
      },
    });
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
      }),
    });
    expect(spaceMemberRepo.getUserSpaceIds).not.toHaveBeenCalled();
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
