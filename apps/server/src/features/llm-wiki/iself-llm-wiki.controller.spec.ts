import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { UserRole } from '../../common/helpers/types/permission';
import { AttachmentType } from '../../core/attachment/attachment.constants';
import { IsElfLlmWikiController } from './iself-llm-wiki.controller';
import { AiKnowledgeChatService } from './services/ai-knowledge-chat.service';
import { KnowledgeRetrievalService } from './services/knowledge-retrieval.service';
import { KnowledgeRetrievalRankerService } from './services/knowledge-retrieval-ranker.service';
import { KnowledgeContextPackService } from './services/knowledge-context-pack.service';
import { KnowledgeCitationAttachmentResolverService } from './services/knowledge-citation-attachment-resolver.service';

describe('IsElfLlmWikiController', () => {
  it('uses the same chat response pipeline as the regular knowledge query', async () => {
    const chatService = {
      isEnabledForWorkspace: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        answer: 'Kafka is used for async events.',
        answerMode: 'knowledge',
        citations: [
          { sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' },
        ],
        citationEvidence: [
          {
            sourcePageId: 'page-1',
            title: 'Kafka',
            url: '/p/page-1',
            excerpts: [],
          },
        ],
        retrievedSources: [
          { sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' },
        ],
        snippets: [
          {
            id: 'chunk-1',
            title: 'Kafka',
            text: 'Use Kafka for async events.',
            retrievalReasons: ['lexical'],
            sourceWindows: [],
          },
        ],
        warnings: [],
        retrievalReasons: ['lexical'],
        budget: {},
        completenessNotice:
          'Some knowledge may be unavailable because access is permission-scoped.',
        retrievalDiagnostics: {
          mode: 'high_completeness',
          queryEmbeddingAvailable: false,
          candidateSourceCount: 1,
          policyCandidateSourceCount: 1,
          fallbackCandidateSourceCount: 0,
          finalAuthorizedSourceCount: 1,
          accessPolicyFallbackUsed: false,
          candidateChunkCount: 1,
          rankedCandidateCount: 1,
          authorizedChunkCount: 1,
          filteredChunkCount: 0,
        },
        retrievalScope: {
          requestedSpaceIds: ['space-1'],
          effectiveSpaceIds: ['space-1'],
        },
        // Internal-only context the controller must strip and use to resolve
        // hit-chunk attachments; it must never leak into the response.
        attachmentHitContext: { directHitChunkIds: ['chunk-1'] },
        queryObservation: {
          decisionReason: 'knowledge',
          finalChunkIds: ['chunk-1'],
          finalSourcePageIds: ['page-1'],
          rankReasonsByChunk: { 'chunk-1': ['lexical'] },
          contextItems: [],
          packContextLength: 10,
          packMaxContextLength: 12000,
          answerContextLength: 20,
          answerContextHash: `sha256:${'a'.repeat(64)}`,
        },
      }),
    };
    const citationImageResolver = {
      resolveImagesForCitations: jest.fn().mockResolvedValue([
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: '/p/page-1',
          images: [],
        },
      ]),
    };
    const queryAuditRepo = {
      recordQuery: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = { log: jest.fn() };
    const agentAccessService = {
      getBoundSpaceIds: jest.fn().mockResolvedValue(['space-1']),
    };
    const environmentService = {
      getAppUrl: jest.fn().mockReturnValue('https://akasha.example.com'),
    };
    const attachmentResolver = {
      resolveAttachments: jest.fn().mockResolvedValue([
        {
          attachmentId: 'attachment-1',
          sourcePageId: 'page-1',
          fileName: 'design.pdf',
          mimeType: 'application/pdf',
          fileSize: 42,
          url: 'https://akasha.example.com/api/files/public/attachment-1/design.pdf?jwt=jwt-1',
        },
      ]),
    };
    const controller = new IsElfLlmWikiController(
      chatService as any,
      citationImageResolver as any,
      queryAuditRepo as any,
      agentAccessService as any,
      auditService as any,
      environmentService as any,
      attachmentResolver as any,
    );
    const user = {
      id: 'user-1',
      workspaceId: 'workspace-1',
      role: UserRole.MEMBER,
      // iself must remain fail-closed even if the user's UI preference is on.
      settings: { preferences: { generalKnowledge: true } },
    } as any;
    const workspace = {
      id: 'workspace-1',
      settings: { ai: { chat: true } },
    } as any;
    const agentAccess = {
      apiKeyId: 'public-key-1',
      credentialVersion: 1,
      agentUser: user,
      workspace,
      delegatedUser: { id: 'delegated-user-1' },
    } as any;

    await expect(
      controller.queryKnowledge(
        {
          query: 'How do we use Kafka?',
          spaceIds: ['space-1'],
          labels: ['项目计划', 'kafka'],
          chatContext: ['Previous turn'],
        },
        user,
        workspace,
        agentAccess,
      ),
    ).resolves.toEqual({
      answer: 'Kafka is used for async events.',
      answerMode: 'knowledge',
      citations: [
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: 'https://akasha.example.com/p/page-1',
          images: [],
        },
      ],
      citationEvidence: [
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: 'https://akasha.example.com/p/page-1',
          excerpts: [],
        },
      ],
      retrievedSources: [
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: 'https://akasha.example.com/p/page-1',
        },
      ],
      snippets: [
        {
          id: 'chunk-1',
          title: 'Kafka',
          text: 'Use Kafka for async events.',
          retrievalReasons: ['lexical'],
          sourceWindows: [],
        },
      ],
      warnings: [],
      retrievalReasons: ['lexical'],
      budget: {},
      completenessNotice:
        'Some knowledge may be unavailable because access is permission-scoped.',
    });

    expect(chatService.chat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      supplementalUserId: 'delegated-user-1',
      query: 'How do we use Kafka?',
      spaceIds: ['space-1'],
      labelNames: ['项目计划', 'kafka'],
      chatContext: ['Previous turn'],
      workspace,
      generalKnowledgeEnabled: false,
    });
    expect(citationImageResolver.resolveImagesForCitations).toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuditEvent.KNOWLEDGE_QUERY,
        resourceType: AuditResource.KNOWLEDGE,
        metadata: expect.objectContaining({
          origin: 'iself_knowledge_query',
          publicApiKeyId: 'public-key-1',
          labelCount: 2,
        }),
      }),
    );
    expect(queryAuditRepo.recordQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        retrievalMode: 'high_completeness',
        metadata: expect.objectContaining({
          origin: 'iself_knowledge_query',
          labelCount: 2,
          decisionReason: 'knowledge',
          finalChunkIds: ['chunk-1'],
        }),
      }),
    );
    expect(attachmentResolver.resolveAttachments).not.toHaveBeenCalled();

    const withAttachments = await controller.queryKnowledge(
      {
        query: 'How do we use Kafka?',
        spaceIds: ['space-1'],
        attachments: true,
        generalKnowledgeEnabled: true,
        scoreThreshold: 0.6,
      },
      user,
      workspace,
      agentAccess,
    );
    expect(withAttachments.attachments).toEqual([
      expect.objectContaining({
        attachmentId: 'attachment-1',
        sourcePageId: 'page-1',
        fileName: 'design.pdf',
      }),
    ]);
    // Internal-only fields must not leak into the response.
    expect(withAttachments).not.toHaveProperty('attachmentHitContext');
    expect(withAttachments).not.toHaveProperty('retrievalDiagnostics');
    expect(withAttachments).not.toHaveProperty('retrievalScope');
    expect(withAttachments).not.toHaveProperty('queryObservation');
    // The resolver receives the direct-hit chunk ids, never citations.
    expect(attachmentResolver.resolveAttachments).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      directHitChunkIds: ['chunk-1'],
    });
    expect(chatService.chat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generalKnowledgeEnabled: true,
        scoreThreshold: 0.6,
      }),
    );

    // rawResultsOnly and queryRewriteEnabled pass through to the service.
    await controller.queryKnowledge(
      {
        query: 'How do we use Kafka?',
        spaceIds: ['space-1'],
        rawResultsOnly: true,
        queryRewriteEnabled: false,
      },
      user,
      workspace,
      agentAccess,
    );
    expect(chatService.chat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rawResultsOnly: true,
        queryRewriteEnabled: false,
      }),
    );

    // includeCitations must not open top-level attachments (§8.1).
    attachmentResolver.resolveAttachments.mockClear();
    const withCitationsOnly = await controller.queryKnowledge(
      {
        query: 'How do we use Kafka?',
        spaceIds: ['space-1'],
        includeCitations: true,
      },
      user,
      workspace,
      agentAccess,
    );
    expect(withCitationsOnly).not.toHaveProperty('attachments');
    expect(attachmentResolver.resolveAttachments).not.toHaveBeenCalled();
  });

  // Full chain: real retrieval -> real chat -> real controller -> real
  // attachment resolver. Only leaf collaborators (repos, providers, token,
  // env) are stubbed, so directHitChunkIds actually flows end to end and the
  // resolver validates + signs real relation rows (§11.3).
  it('resolves hit-chunk attachments across the full iself request chain', async () => {
    const updatedAt = new Date('2026-02-01T00:00:00.000Z');
    const hitChunk = {
      chunk: {
        id: 'chunk-hit',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        knowledgePageId: 'kp-1',
        text: 'Kafka setup guide',
        contentHash: 'chunk-hit-hash',
        embedding: null,
        embeddingProfile: null,
        embeddingModel: null,
        embeddingDimensions: null,
        searchTsv: null,
        compilerRunId: 'run-1',
        compileTaskId: 'task-1',
        staleAt: null,
        createdAt: updatedAt,
      },
      page: {
        id: 'kp-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        title: 'Kafka',
        slug: 'kp-1',
      },
      sourcePageIds: ['page-1'],
      signals: ['lexical'],
      lexicalScore: 1,
    };
    // Shared repo mock: retrieval recall methods + resolver relation lookups.
    const capsuleRepo = {
      findDenseChunkCandidates: jest.fn().mockResolvedValue([]),
      findLexicalChunkCandidates: jest.fn().mockResolvedValue([hitChunk]),
      findExactTitleChunkCandidates: jest.fn().mockResolvedValue([]),
      findChunkSourcePageIdsByChunkIds: jest
        .fn()
        .mockResolvedValue([
          { chunkId: 'chunk-hit', sourcePageIds: ['page-1'] },
        ]),
      findGraphFrontierSourceIds: jest.fn().mockResolvedValue([]),
      findGraphTraversalEdges: jest.fn().mockResolvedValue([]),
      findChunkAttachmentsByChunkIds: jest.fn().mockResolvedValue([
        {
          chunkId: 'chunk-hit',
          attachments: [
            {
              occurrenceOrder: 0,
              attachmentId: 'att-1',
              sourcePageId: 'page-1',
              sourceVersion: 'page-1-version',
              sourceContentHash: 'att-1-content-hash',
              attachmentUpdatedAt: updatedAt,
            },
          ],
        },
      ]),
      findChunkSourceRefsByChunkIds: jest.fn().mockResolvedValue([
        {
          chunkId: 'chunk-hit',
          sources: [
            {
              sourcePageId: 'page-1',
              sourceVersion: 'page-1-version',
              contentHash: 'att-1-content-hash',
              sourceRange: null,
              quoteHash: null,
            },
          ],
        },
      ]),
    };
    const retrieval = new KnowledgeRetrievalService(
      {
        findById: jest.fn().mockResolvedValue({
          id: 'user-1',
          role: UserRole.MEMBER,
          workspaceId: 'workspace-1',
        }),
      } as any,
      {
        filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-1']),
      } as any,
      capsuleRepo as any,
      { getUserGroupIds: jest.fn().mockResolvedValue([]) } as any,
      {
        filterReadableSources: jest.fn().mockResolvedValue(['page-1']),
      } as any,
      { embedQuery: jest.fn().mockResolvedValue(null) } as any,
      new KnowledgeRetrievalRankerService(),
    );
    // No source windows -> no knowledge evidence -> no_match branch, which
    // still carries attachmentHitContext (§1.2).
    const answerProvider = {
      answer: jest.fn().mockResolvedValue('irrelevant'),
    };
    const citationResolver = {
      resolveForChunks: jest.fn().mockResolvedValue([]),
      resolveForCapsules: jest.fn().mockResolvedValue([]),
    };
    const chatService = new AiKnowledgeChatService(
      retrieval,
      new KnowledgeContextPackService(),
      citationResolver as any,
      answerProvider as any,
    );

    const attachmentRepo = {
      findByIds: jest.fn().mockResolvedValue([
        {
          id: 'att-1',
          pageId: 'page-1',
          workspaceId: 'workspace-1',
          fileName: 'setup.pdf',
          fileExt: 'pdf',
          mimeType: 'application/pdf',
          fileSize: 42,
          type: AttachmentType.File,
          deletedAt: null,
          updatedAt,
        },
      ]),
    };
    const resolver = new KnowledgeCitationAttachmentResolverService(
      attachmentRepo as any,
      {
        generateAttachmentToken: jest
          .fn()
          .mockImplementation(async ({ attachmentId }: any) => `jwt-${attachmentId}`),
      } as any,
      { getAppUrl: () => 'https://akasha.example.com' } as any,
      capsuleRepo as any,
    );

    const controller = new IsElfLlmWikiController(
      chatService as any,
      {
        resolveImagesForCitations: jest.fn().mockResolvedValue([]),
      } as any,
      { recordQuery: jest.fn().mockResolvedValue(undefined) } as any,
      { getBoundSpaceIds: jest.fn().mockResolvedValue(['space-1']) } as any,
      { log: jest.fn() } as any,
      { getAppUrl: () => 'https://akasha.example.com' } as any,
      resolver,
    );

    const user = {
      id: 'user-1',
      workspaceId: 'workspace-1',
      role: UserRole.MEMBER,
    } as any;
    const workspace = {
      id: 'workspace-1',
      settings: { ai: { chat: true } },
    } as any;
    const agentAccess = {
      apiKeyId: 'public-key-1',
      delegatedUser: { id: 'delegated-user-1' },
    } as any;

    const response = await controller.queryKnowledge(
      { query: 'kafka setup', spaceIds: ['space-1'], attachments: true },
      user,
      workspace,
      agentAccess,
    );

    expect(response.attachments).toEqual([
      {
        attachmentId: 'att-1',
        sourcePageId: 'page-1',
        fileName: 'setup.pdf',
        mimeType: 'application/pdf',
        fileSize: 42,
        url: 'https://akasha.example.com/api/files/public/att-1/setup.pdf?jwt=jwt-att-1',
      },
    ]);
    // The resolver was driven by the real direct-hit chunk ids, never citations.
    expect(capsuleRepo.findChunkAttachmentsByChunkIds).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      chunkIds: ['chunk-hit'],
    });
    // Internal context never leaks to the wire.
    expect(response).not.toHaveProperty('attachmentHitContext');
  });
});
