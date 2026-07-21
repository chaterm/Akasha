import { ForbiddenException } from '@nestjs/common';
import { Workspace } from '@akasha/db/types/entity.types';
import { KnowledgeContextPackService } from './knowledge-context-pack.service';
import { KnowledgeCitationResolverService } from './knowledge-citation-resolver.service';
import { KNOWLEDGE_COMPLETENESS_NOTICE } from './knowledge-retrieval.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import {
  AiKnowledgeChatService,
  KnowledgeAnswerProvider,
} from './ai-knowledge-chat.service';

describe('AiKnowledgeChatService', () => {
  it('retrieves, packs authorized chunk context, and returns answer without raw capsules', async () => {
    const retrieval = {
      retrieve: jest.fn().mockResolvedValue({
        mode: 'high_completeness',
        chunks: [
          {
            chunk: chunk('chunk-1', 'kp-1', '登记批准日期：2026年06月05日'),
            page: capsule('kp-1', 'Chaterm'),
            sourcePageIds: ['page-1'],
            rankReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
          },
        ],
        capsules: [],
        completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
        diagnostics: {
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
        },
      }),
    };
    const contextPack = {
      buildContextPack: jest.fn().mockReturnValue({
        context: '# Chaterm\n登记批准日期：2026年06月05日',
        citations: [
          { sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' },
        ],
        primary: [
          {
            id: 'chunk-1',
            kind: 'chunk',
            title: 'Chaterm',
            text: '登记批准日期：2026年06月05日',
            citationSourcePageIds: ['page-1'],
            retrievalReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
            sourceWindows: [
              {
                sourcePageId: 'page-1',
                title: 'Kafka',
                url: '/p/page-1',
                text: '登记批准日期：2026年06月05日',
                sourceRange: { startOffset: 0, endOffset: 18 },
                quoteHash: 'sha256:quote',
              },
            ],
          },
        ],
        warnings: ['Some retrieved knowledge may be stale.'],
        retrievalReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
        budget: {
          maxContextLength: 12000,
          usedContextLength: 28,
          remainingContextLength: 11972,
          includedItemCount: 1,
          omittedItemCount: 0,
          responseReserve: 0,
          perItemMaxLength: 12000,
        },
        completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      }),
    };
    const answerProvider = {
      answer: jest
        .fn()
        .mockResolvedValue('Kafka is used for async events. [[cite:page-1]]'),
    };
    const citationResolver = {
      resolveForCapsules: jest.fn(),
      resolveForChunks: jest.fn().mockResolvedValue([
        {
          chunk: chunk('chunk-1', 'kp-1', '登记批准日期：2026年06月05日'),
          pageTitle: 'Chaterm',
          retrievalReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
          sourceWindows: [
            {
              sourcePageId: 'page-1',
              title: 'Kafka',
              url: '/p/page-1',
              text: '登记批准日期：2026年06月05日',
              sourceRange: { startOffset: 0, endOffset: 18 },
              quoteHash: 'sha256:quote',
            },
          ],
          warnings: ['Some retrieved knowledge may be stale.'],
          citations: [
            { sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' },
          ],
        },
      ]),
    };
    const service = createService({
      retrieval,
      contextPack,
      answerProvider,
      citationResolver,
    });

    await expect(
      service.chat({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'Chaterm 登记批准日期',
        spaceIds: ['space-1'],
        chatContext: ['Previous turn'],
      }),
    ).resolves.toEqual({
      answer: 'Kafka is used for async events.',
      citations: [{ sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' }],
      snippets: [
        {
          id: 'chunk-1',
          title: 'Chaterm',
          text: '登记批准日期：2026年06月05日',
          retrievalReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
          sourceWindows: [
            {
              sourcePageId: 'page-1',
              title: 'Kafka',
              url: '/p/page-1',
              text: '登记批准日期：2026年06月05日',
              sourceRange: { startOffset: 0, endOffset: 18 },
              quoteHash: 'sha256:quote',
            },
          ],
        },
      ],
      warnings: ['Some retrieved knowledge may be stale.'],
      retrievalReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
      budget: {
        maxContextLength: 12000,
        usedContextLength: 28,
        remainingContextLength: 11972,
        includedItemCount: 1,
        omittedItemCount: 0,
        responseReserve: 0,
        perItemMaxLength: 12000,
      },
      completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      retrievalDiagnostics: {
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
      },
    });

    expect(retrieval.retrieve).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'Chaterm 登记批准日期',
      spaceIds: ['space-1'],
    });
    expect(contextPack.buildContextPack).toHaveBeenCalledWith({
      chunks: [
        {
          chunk: chunk('chunk-1', 'kp-1', '登记批准日期：2026年06月05日'),
          pageTitle: 'Chaterm',
          retrievalReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
          sourceWindows: [
            {
              sourcePageId: 'page-1',
              title: 'Kafka',
              url: '/p/page-1',
              text: '登记批准日期：2026年06月05日',
              sourceRange: { startOffset: 0, endOffset: 18 },
              quoteHash: 'sha256:quote',
            },
          ],
          warnings: ['Some retrieved knowledge may be stale.'],
          citations: [
            { sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' },
          ],
        },
      ],
    });
    expect(citationResolver.resolveForChunks).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      chunks: [
        {
          chunk: chunk('chunk-1', 'kp-1', '登记批准日期：2026年06月05日'),
          page: capsule('kp-1', 'Chaterm'),
          sourcePageIds: ['page-1'],
          rankReasons: ['exact-title', 'lexical', 'sidecar-prefiltered'],
        },
      ],
    });
    expect(citationResolver.resolveForCapsules).not.toHaveBeenCalled();
    expect(answerProvider.answer).toHaveBeenCalledWith({
      query: 'Chaterm 登记批准日期',
      context:
        '# Chaterm\nCitation IDs: [[cite:page-1]]\n登记批准日期：2026年06月05日',
      chatContext: ['Previous turn'],
    });
  });

  it('allows knowledge chat when the workspace switch is enabled without requiring an AI license feature', async () => {
    const service = createService({
      answerProvider: {
        answer: jest.fn().mockResolvedValue('grounded answer'),
      },
    });

    await expect(
      service.chat({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'Kafka?',
        spaceIds: ['space-1'],
        workspace: workspace({ aiChat: true }),
      }),
    ).resolves.toMatchObject({
      answer: 'grounded answer',
      citations: [],
    });
  });

  it('returns only citations explicitly used by the generated answer', async () => {
    const contextPack = {
      buildContextPack: jest.fn().mockReturnValue({
        context: '# Chaterm\n登记批准日期：2026年06月05日',
        citations: [
          {
            sourcePageId: 'page-used',
            title: 'Chaterm 企业版登记信息',
            url: '/p/page-used',
          },
          {
            sourcePageId: 'page-retrieved-only',
            title: 'Chaterm KMS 加密架构',
            url: '/p/page-retrieved-only',
          },
        ],
        primary: [
          {
            id: 'chunk-1',
            kind: 'chunk',
            title: 'Chaterm',
            text: '登记批准日期：2026年06月05日',
            citationSourcePageIds: ['page-used', 'page-retrieved-only'],
            retrievalReasons: ['lexical'],
            sourceWindows: [],
          },
        ],
        warnings: [],
        retrievalReasons: ['lexical'],
        budget: {
          maxContextLength: 12000,
          usedContextLength: 28,
          remainingContextLength: 11972,
          includedItemCount: 1,
          omittedItemCount: 0,
          responseReserve: 0,
          perItemMaxLength: 12000,
        },
        completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      }),
    };
    const answerProvider = {
      answer: jest
        .fn()
        .mockResolvedValue(
          'Chaterm 的软件著作权生效时间是 2026 年 06 月 05 日。 [[cite:page-used]]',
        ),
    };
    const service = createService({
      retrieval: {
        retrieve: jest.fn().mockResolvedValue({
          mode: 'high_completeness',
          chunks: [chunk('chunk-1', 'kp-1', '登记批准日期：2026年06月05日')],
          capsules: [],
          completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
          diagnostics: {},
        }),
      },
      citationResolver: {
        resolveForChunks: jest.fn().mockResolvedValue([
          {
            chunk: chunk('chunk-1', 'kp-1', '登记批准日期：2026年06月05日'),
            pageTitle: 'Chaterm',
            retrievalReasons: ['lexical'],
            sourceWindows: [],
            warnings: [],
            citations: [
              {
                sourcePageId: 'page-used',
                title: 'Chaterm 企业版登记信息',
                url: '/p/page-used',
              },
              {
                sourcePageId: 'page-retrieved-only',
                title: 'Chaterm KMS 加密架构',
                url: '/p/page-retrieved-only',
              },
            ],
          },
        ]),
      },
      contextPack,
      answerProvider,
    });

    const result = await service.chat({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'chaterm 的软著生效时间是',
      spaceIds: ['space-1'],
    });

    expect(result.answer).toBe(
      'Chaterm 的软件著作权生效时间是 2026 年 06 月 05 日。',
    );
    expect(result.citations).toEqual([
      {
        sourcePageId: 'page-used',
        title: 'Chaterm 企业版登记信息',
        url: '/p/page-used',
      },
    ]);
    expect(answerProvider.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('[[cite:page-used]]'),
      }),
    );
  });

  it('enables chat when workspace ai.chat is enabled', () => {
    const service = createService();

    expect(service.isEnabledForWorkspace(workspace({ aiChat: true }))).toBe(
      true,
    );
    expect(service.isEnabledForWorkspace(workspace({ aiChat: false }))).toBe(
      false,
    );
  });

  it('loads authorized current pages, mentions, and owned attachments as explicit context', async () => {
    const answer = jest
      .fn()
      .mockResolvedValue('Use the current page. [[cite:page-current]]');
    const service = createService({
      answerProvider: { answer },
      pageRepo: {
        findManyByIds: jest.fn().mockResolvedValue([
          {
            id: 'page-current',
            title: 'Current design',
            slugId: 'current-design',
            textContent: 'ACL must run before LIMIT.',
          },
        ]),
      },
      sourceAuthorization: {
        filterReadableSources: jest.fn().mockResolvedValue(['page-current']),
      },
      attachmentRepo: {
        findByIdWithContent: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'attachment-owned',
            workspaceId: 'workspace-1',
            creatorId: 'user-1',
            fileName: 'notes.txt',
            textContent: 'Temporary attachment evidence.',
          })
          .mockResolvedValueOnce({
            id: 'attachment-foreign',
            workspaceId: 'workspace-1',
            creatorId: 'user-2',
            fileName: 'hidden.txt',
            textContent: 'Must not leak.',
          }),
      },
    });

    const result = await service.chat({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'Explain this',
      spaceIds: ['space-1'],
      contextPageId: 'page-current',
      mentionedPageIds: ['page-hidden'],
      attachmentIds: ['attachment-owned', 'attachment-foreign'],
    });

    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('ACL must run before LIMIT.'),
      }),
    );
    const context = answer.mock.calls[0][0].context as string;
    expect(context).toContain('Temporary attachment evidence.');
    expect(context).not.toContain('Must not leak.');
    expect(context).not.toContain('page-hidden');
    expect(result.citations).toEqual([
      {
        sourcePageId: 'page-current',
        title: 'Current design',
        url: '/p/current-design',
      },
    ]);
  });
});

function createService(
  overrides: {
    retrieval?: Partial<KnowledgeRetrievalService>;
    contextPack?: Partial<KnowledgeContextPackService>;
    citationResolver?: Partial<KnowledgeCitationResolverService>;
    answerProvider?: Partial<KnowledgeAnswerProvider>;
    pageRepo?: Record<string, unknown>;
    sourceAuthorization?: Record<string, unknown>;
    attachmentRepo?: Record<string, unknown>;
  } = {},
) {
  return new AiKnowledgeChatService(
    {
      retrieve: jest.fn().mockResolvedValue({
        mode: 'high_completeness',
        chunks: [],
        capsules: [],
        completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      }),
      ...overrides.retrieval,
    } as unknown as KnowledgeRetrievalService,
    {
      buildContextPack: jest.fn().mockReturnValue({
        context: '',
        citations: [],
        primary: [],
        warnings: [],
        retrievalReasons: [],
        budget: {
          maxContextLength: 12000,
          usedContextLength: 0,
          remainingContextLength: 12000,
          includedItemCount: 0,
          omittedItemCount: 0,
          responseReserve: 0,
          perItemMaxLength: 12000,
        },
        completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      }),
      ...overrides.contextPack,
    } as unknown as KnowledgeContextPackService,
    {
      resolveForCapsules: jest.fn().mockResolvedValue([]),
      resolveForChunks: jest.fn().mockResolvedValue([]),
      ...overrides.citationResolver,
    } as unknown as KnowledgeCitationResolverService,
    {
      answer: jest.fn().mockResolvedValue(''),
      ...overrides.answerProvider,
    } as unknown as KnowledgeAnswerProvider,
    overrides.pageRepo as never,
    overrides.sourceAuthorization as never,
    overrides.attachmentRepo as never,
  );
}

function workspace(input: { aiChat: boolean }): Workspace {
  return {
    id: 'workspace-1',
    licenseKey: 'license-key',
    plan: 'business',
    settings: { ai: { chat: input.aiChat } },
  } as unknown as Workspace;
}

function capsule(id: string, title = 'Kafka') {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: 'space',
    title,
    slug: id,
    pageType: null,
    body: 'Use Kafka.',
    summary: null,
    compiledAt: new Date('2026-06-16T00:00:00.000Z'),
    compilerVersion: 'compiler@1',
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
    updatedAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}

function chunk(id: string, knowledgePageId: string, text: string) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    knowledgePageId,
    claimId: null,
    text,
    contentHash: `hash-${id}`,
    embedding: [0.1, 0.2],
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-06-16T00:00:00.000Z'),
  };
}
