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
  it('falls back to verified source evidence when the model omits citation markers', async () => {
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
      answer: jest.fn().mockResolvedValue('Kafka is used for async events.'),
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
      answerMode: 'knowledge',
      citations: [{ sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' }],
      citationEvidence: [
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: '/p/page-1',
          excerpts: [
            {
              text: '登记批准日期：2026年06月05日',
              sourceRange: { startOffset: 0, endOffset: 18 },
              quoteHash: 'sha256:quote',
            },
          ],
        },
      ],
      retrievedSources: [
        { sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' },
      ],
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
      query: 'Chaterm 登记批准日期',
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
        '# Chaterm\nCitation IDs: [[cite:page-1]]\n登记批准日期：2026年06月05日\n## Verified source evidence 1: Kafka\nCitation ID: [[cite:page-1]]\n登记批准日期：2026年06月05日',
      chatContext: ['Previous turn'],
    });
  });

  it('automatically answers with general knowledge when retrieval has no verified evidence', async () => {
    const answer = jest.fn().mockResolvedValue('Kafka is an event platform.');
    const onToken = jest.fn();
    const service = createService({
      answerProvider: { answer },
    });

    const result = await service.chat({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'Kafka?',
      spaceIds: ['space-1'],
      workspace: workspace({ aiChat: true }),
      onToken,
    });

    expect(answer).toHaveBeenCalledWith({
      query: 'Kafka?',
      context: '',
      chatContext: undefined,
      mode: 'general',
    });
    expect(result).toMatchObject({
      answer:
        '> This answer uses general model knowledge and does not cite the workspace knowledge base.\n\nKafka is an event platform.',
      answerMode: 'general',
      citations: [],
      citationEvidence: [],
      retrievedSources: [],
    });
    expect(onToken.mock.calls.map(([text]) => text).join('')).toBe(
      result.answer,
    );
  });

  it('answers from general model knowledge only after an explicit request', async () => {
    const retrieval = { retrieve: jest.fn() };
    const answer = jest.fn().mockResolvedValue('Shanghai summers are hot.');
    const onToken = jest.fn();
    const service = createService({
      retrieval,
      answerProvider: { answer },
    });

    const result = await service.chat({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'What is Shanghai weather like in July?',
      spaceIds: ['space-1'],
      chatContext: ['user: What is the weather today?'],
      responseMode: 'general',
      onToken,
    });

    expect(retrieval.retrieve).not.toHaveBeenCalled();
    expect(answer).toHaveBeenCalledWith({
      query: 'What is Shanghai weather like in July?',
      context: '',
      chatContext: ['user: What is the weather today?'],
      mode: 'general',
    });
    expect(result).toMatchObject({
      answer:
        '> This answer uses general model knowledge and does not cite the workspace knowledge base.\n\nShanghai summers are hot.',
      answerMode: 'general',
      citations: [],
      citationEvidence: [],
      retrievedSources: [],
      snippets: [],
    });
    expect(onToken.mock.calls.map(([text]) => text).join('')).toBe(
      result.answer,
    );
  });

  it('rewrites a follow-up question with conversation history before retrieval', async () => {
    const rewriteQuery = jest.fn().mockResolvedValue('Codex 的套餐多少钱');
    const onStage = jest.fn();
    const retrieval = {
      retrieve: jest.fn().mockResolvedValue({
        mode: 'high_completeness',
        chunks: [],
        capsules: [],
        completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      }),
    };
    const service = createService({
      retrieval,
      answerProvider: { rewriteQuery } as never,
    });

    const result = await service.chat({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: '套餐多少钱',
      spaceIds: ['space-1'],
      chatContext: [
        'user: Codex 开通目前可以看到哪些人已经开通了',
        'assistant: 可以在 Codex 管理页面查看。',
      ],
      onStage,
    });

    expect(rewriteQuery).toHaveBeenCalledWith({
      query: '套餐多少钱',
      chatContext: [
        'user: Codex 开通目前可以看到哪些人已经开通了',
        'assistant: 可以在 Codex 管理页面查看。',
      ],
    });
    expect(retrieval.retrieve).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'Codex 的套餐多少钱',
      spaceIds: ['space-1'],
    });
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
      'understanding',
      'retrieval',
      'generation',
    ]);
    expect(result.retrievalQuery).toBe('Codex 的套餐多少钱');
  });

  it('uses the original question when contextual query rewriting fails', async () => {
    const retrieval = {
      retrieve: jest.fn().mockResolvedValue({
        mode: 'high_completeness',
        chunks: [],
        capsules: [],
        completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
      }),
    };
    const service = createService({
      retrieval,
      answerProvider: {
        rewriteQuery: jest.fn().mockRejectedValue(new Error('model timeout')),
      } as never,
    });

    await service.chat({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: '套餐多少钱',
      spaceIds: ['space-1'],
      chatContext: ['user: Codex 开通'],
    });

    expect(retrieval.retrieve).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: '套餐多少钱',
      spaceIds: ['space-1'],
    });
  });

  it('adds verified raw source evidence when the compiled summary omitted the requested URL', async () => {
    const sourceWindow = {
      sourcePageId: 'page-dms',
      title: 'DMS 接口原文',
      url: '/p/dms-api',
      text: 'URL：/customized_query_sql\n请求方法：POST',
      sourceRange: { startOffset: 18, endOffset: 58 },
      quoteHash: 'sha256:dms-evidence',
    };
    const answerProvider = {
      answer: jest
        .fn()
        .mockResolvedValue(
          '接口 URL 是 /customized_query_sql，方法是 POST。 [[cite:page-dms]]',
        ),
    };
    const service = createService({
      retrieval: {
        retrieve: jest.fn().mockResolvedValue({
          mode: 'high_completeness',
          chunks: [chunk('chunk-dms', 'kp-dms', '该接口用于定制 SQL 查询。')],
          capsules: [],
          diagnostics: {},
        }),
      },
      citationResolver: {
        resolveForChunks: jest.fn().mockResolvedValue([
          {
            chunk: chunk('chunk-dms', 'kp-dms', '该接口用于定制 SQL 查询。'),
            pageTitle: 'DMS 定制查询SQL返回接口',
            retrievalReasons: ['semantic'],
            sourceWindows: [sourceWindow],
            warnings: [],
            citations: [
              {
                sourcePageId: 'page-dms',
                title: 'DMS 接口原文',
                url: '/p/dms-api',
              },
            ],
          },
        ]),
      },
      contextPack: {
        buildContextPack: jest.fn().mockReturnValue({
          context: '# DMS 定制查询SQL返回接口\n该接口用于定制 SQL 查询。',
          citations: [
            {
              sourcePageId: 'page-dms',
              title: 'DMS 接口原文',
              url: '/p/dms-api',
            },
          ],
          primary: [
            {
              id: 'chunk-dms',
              kind: 'chunk',
              title: 'DMS 定制查询SQL返回接口',
              text: '该接口用于定制 SQL 查询。',
              citationSourcePageIds: ['page-dms'],
              retrievalReasons: ['semantic'],
              sourceWindows: [sourceWindow],
            },
          ],
          warnings: [],
          retrievalReasons: ['semantic'],
          budget: {
            maxContextLength: 12000,
            usedContextLength: 30,
            remainingContextLength: 11970,
            includedItemCount: 1,
            omittedItemCount: 0,
            responseReserve: 0,
            perItemMaxLength: 12000,
          },
          completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
        }),
      },
      answerProvider,
    });

    const result = await service.chat({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'DMS 定制查询SQL返回接口的 URL 和请求方法是什么？',
      spaceIds: ['space-1'],
    });

    expect(result.answer).toContain('/customized_query_sql');
    expect(answerProvider.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining(
          'URL：/customized_query_sql\n请求方法：POST',
        ),
      }),
    );
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
            sourceWindows: [
              {
                sourcePageId: 'page-used',
                title: 'Chaterm 企业版登记信息',
                url: '/p/page-used',
                text: '登记批准日期：2026年06月05日',
                sourceRange: { startOffset: 12, endOffset: 30 },
                quoteHash: 'sha256:used',
              },
              {
                sourcePageId: 'page-retrieved-only',
                title: 'Chaterm KMS 加密架构',
                url: '/p/page-retrieved-only',
                text: '这是另一个只参与检索的页面。',
                sourceRange: { startOffset: 0, endOffset: 14 },
                quoteHash: 'sha256:retrieved-only',
              },
            ],
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
            sourceWindows: [
              {
                sourcePageId: 'page-used',
                title: 'Chaterm 企业版登记信息',
                url: '/p/page-used',
                text: '登记批准日期：2026年06月05日',
                sourceRange: { startOffset: 12, endOffset: 30 },
                quoteHash: 'sha256:used',
              },
              {
                sourcePageId: 'page-retrieved-only',
                title: 'Chaterm KMS 加密架构',
                url: '/p/page-retrieved-only',
                text: '这是另一个只参与检索的页面。',
                sourceRange: { startOffset: 0, endOffset: 14 },
                quoteHash: 'sha256:retrieved-only',
              },
            ],
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
    expect(result.citationEvidence).toEqual([
      {
        sourcePageId: 'page-used',
        title: 'Chaterm 企业版登记信息',
        url: '/p/page-used',
        excerpts: [
          {
            text: '登记批准日期：2026年06月05日',
            sourceRange: { startOffset: 12, endOffset: 30 },
            quoteHash: 'sha256:used',
          },
        ],
      },
    ]);
    expect(result.retrievedSources).toEqual([
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
    ]);
    expect(answerProvider.answer).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.stringContaining('[[cite:page-used]]'),
      }),
    );
  });

  it('uses general knowledge without promoting summary-only retrieval as trusted evidence', async () => {
    const citation = {
      sourcePageId: 'page-summary-only',
      title: 'Compiled summary only',
      url: '/p/summary-only',
    };
    const answer = jest
      .fn()
      .mockResolvedValue('Unsupported answer. [[cite:page-summary-only]]');
    const service = createService({
      retrieval: {
        retrieve: jest.fn().mockResolvedValue({
          mode: 'high_completeness',
          chunks: [chunk('chunk-1', 'kp-1', 'A compressed statement.')],
          capsules: [],
          diagnostics: {},
        }),
      },
      citationResolver: {
        resolveForChunks: jest.fn().mockResolvedValue([
          {
            chunk: chunk('chunk-1', 'kp-1', 'A compressed statement.'),
            pageTitle: 'Summary',
            retrievalReasons: ['semantic'],
            sourceWindows: [],
            warnings: [],
            citations: [citation],
          },
        ]),
      },
      contextPack: {
        buildContextPack: jest.fn().mockReturnValue({
          context: '# Summary\nA compressed statement.',
          citations: [citation],
          primary: [
            {
              id: 'chunk-1',
              kind: 'chunk',
              title: 'Summary',
              text: 'A compressed statement.',
              citationSourcePageIds: ['page-summary-only'],
              retrievalReasons: ['semantic'],
              sourceWindows: [],
            },
          ],
          warnings: [],
          retrievalReasons: ['semantic'],
          budget: {
            maxContextLength: 12000,
            usedContextLength: 31,
            remainingContextLength: 11969,
            includedItemCount: 1,
            omittedItemCount: 0,
            responseReserve: 0,
            perItemMaxLength: 12000,
          },
          completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
        }),
      },
      answerProvider: {
        answer,
      },
    });

    const result = await service.chat({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'What is the exact fact?',
      spaceIds: ['space-1'],
    });

    expect(result).toMatchObject({
      answerMode: 'general',
      citations: [],
      citationEvidence: [],
      retrievedSources: [],
    });
    expect(answer).toHaveBeenCalledWith({
      query: 'What is the exact fact?',
      context: '',
      chatContext: undefined,
      mode: 'general',
    });
  });

  it('returns a visible diagnostic answer when the configured model produces no text', async () => {
    const service = createService({
      retrieval: {
        retrieve: jest.fn().mockResolvedValue({
          mode: 'high_completeness',
          chunks: [chunk('chunk-1', 'kp-1', 'Documented evidence')],
          capsules: [],
          diagnostics: {
            queryEmbeddingAvailable: true,
            authorizedChunkCount: 1,
          },
        }),
      },
      citationResolver: {
        resolveForChunks: jest.fn().mockResolvedValue([]),
      },
      contextPack: {
        buildContextPack: jest.fn().mockReturnValue({
          context: 'Documented evidence',
          citations: [],
          primary: [
            {
              id: 'chunk-1',
              title: 'Evidence',
              text: 'Documented evidence',
              retrievalReasons: ['lexical'],
              sourceWindows: [
                {
                  sourcePageId: 'page-evidence',
                  title: 'Evidence source',
                  url: '/p/evidence',
                  text: 'Documented evidence',
                  sourceRange: { startOffset: 0, endOffset: 19 },
                  quoteHash: 'sha256:evidence',
                },
              ],
              citationSourcePageIds: ['page-evidence'],
            },
          ],
          warnings: [],
          retrievalReasons: ['lexical'],
          budget: {
            maxContextLength: 12000,
            usedContextLength: 19,
            remainingContextLength: 11981,
            includedItemCount: 1,
            omittedItemCount: 0,
            responseReserve: 0,
            perItemMaxLength: 12000,
          },
          completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
        }),
      },
      answerProvider: { answer: jest.fn().mockResolvedValue('') },
    });

    await expect(
      service.chat({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        query: 'What is documented?',
        spaceIds: ['space-1'],
      }),
    ).resolves.toMatchObject({
      answer:
        'Relevant knowledge was retrieved, but the answer model did not produce a response. Try again later or ask an administrator to check the AI model configuration.',
      answerMode: 'knowledge',
    });
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
