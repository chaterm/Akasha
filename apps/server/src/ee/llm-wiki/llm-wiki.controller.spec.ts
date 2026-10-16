import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { UserRole } from '../../common/helpers/types/permission';
import { IAuditService } from '../../integrations/audit/audit.service';
import { QueueJob } from '../../integrations/queue/constants';
import { KNOWLEDGE_COMPLETENESS_NOTICE } from './services/knowledge-retrieval.service';
import { AiKnowledgeChatService } from './services/ai-knowledge-chat.service';
import { KnowledgeCitationImageResolverService } from './services/knowledge-citation-image-resolver.service';
import { LlmWikiController } from './llm-wiki.controller';
import { KnowledgeDiagnosticsService } from './services/knowledge-diagnostics.service';
import { KnowledgeGraphService } from './services/knowledge-graph.service';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { KnowledgeSourceExporterService } from './services/knowledge-source-exporter.service';
import { KnowledgeSpaceCompilationService } from './services/knowledge-space-compilation.service';
import { KnowledgeSpaceResetService } from './services/knowledge-space-reset.service';
import { AiModelConfigService } from './services/ai-model-config.service';
import { AiModelConfigTestService } from './services/ai-model-config-test.service';
import { SpaceAuthorizationService } from '../../core/space/services/space-authorization.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { ApiKeyService } from '../api-key/api-key.service';
import { withApiKeyAccess } from '../../common/auth/api-key-access';
import { KnowledgeQueryType } from './dto/query-knowledge.dto';
import { EnvironmentService } from '../../integrations/environment/environment.service';

describe('LlmWikiController', () => {
  it('rejects queries when workspace AI knowledge chat is disabled', async () => {
    const chatService = {
      isEnabledForWorkspace: jest.fn().mockReturnValue(false),
      chat: jest.fn(),
    };
    const controller = createController({ chatService });

    await expect(
      controller.queryKnowledge(
        { query: 'Kafka?', spaceIds: ['space-1'] },
        user(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(chatService.chat).not.toHaveBeenCalled();
  });

  it('queries knowledge chat and audits without storing the raw query', async () => {
    const chatService = {
      isEnabledForWorkspace: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        answer: 'Use Kafka for async events.',
        answerMode: 'knowledge',
        citations: [
          { sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' },
        ],
        completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
        retrievalDiagnostics: {
          mode: 'high_completeness',
          queryEmbeddingAvailable: false,
          candidateSourceCount: 4,
          policyCandidateSourceCount: 2,
          fallbackCandidateSourceCount: 0,
          finalAuthorizedSourceCount: 1,
          accessPolicyFallbackUsed: false,
          candidateChunkCount: 3,
          rankedCandidateCount: 3,
          authorizedChunkCount: 1,
          filteredChunkCount: 2,
        },
        retrievalScope: {
          requestedSpaceIds: ['space-1'],
          effectiveSpaceIds: ['space-1'],
        },
        // Internal retrieval detail the shared chat service attaches on every
        // branch; the regular query API must strip it, never expose it (§7.1).
        attachmentHitContext: { directHitChunkIds: ['chunk-1'] },
        // Phase timings are audit-only: stripped from the response below, and
        // recorded under metadata.timings. ttftMs is measured from the
        // generation request, so it is not bounded by the phases before it.
        timings: {
          rewriteMs: 310.2,
          retrievalMs: 412.3,
          ttftMs: 1157.2,
          generationMs: 3240.1,
          totalMs: 3702.8,
        },
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
        retrieval: {
          attempted: true,
          candidates: [
            {
              pageId: 'page-1',
              chunkId: 'chunk-1',
              score: 0.016,
              scoreType: 'lexical',
              reasons: ['lexical'],
              stage: 'direct',
              authorizationMode: 'policy',
            },
          ],
          dropped: [],
          topK: 20,
          threshold: 0.45,
        },
        context: {
          text: '# Kafka\nKafka backs async events.',
          items: [
            {
              itemId: 'chunk-1',
              pageId: 'page-1',
              text: 'Kafka backs async events.',
              tokenCount: 6,
            },
          ],
          usedTokens: 6,
          maxTokens: 3000,
          dropped: [],
        },
      }),
    };
    const auditService = {
      log: jest.fn(),
    };
    const queryAuditRepo = {
      recordQuery: jest.fn().mockResolvedValue(undefined),
    };
    const controller = createController({
      chatService,
      auditService,
      queryAuditRepo,
    });

    // Exact match: proves attachmentHitContext/retrievalDiagnostics/retrievalScope
    // are all stripped, not just absent from the mock.
    await expect(
      controller.queryKnowledge(
        { query: 'How do we use Kafka?', spaceIds: ['space-1'] },
        user(),
        workspace(),
      ),
    ).resolves.toEqual({
      answer: 'Use Kafka for async events.',
      answerMode: 'knowledge',
      citations: [
        {
          sourcePageId: 'page-1',
          title: 'Kafka',
          url: '/p/page-1',
          images: [],
        },
      ],
      completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
    });

    expect(chatService.chat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'How do we use Kafka?',
      spaceIds: ['space-1'],
      workspace: workspace(),
      // Opt-in: without this the service does not return `timings`, so the
      // audit row below would silently lose its phase breakdown.
      collectTimings: true,
    });
    expect(auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.KNOWLEDGE_QUERY,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: 'workspace-1',
      metadata: {
        queryHash: expect.stringMatching(/^sha256:/),
        spaceIds: ['space-1'],
        requestedSpaceIds: ['space-1'],
        effectiveSpaceIds: ['space-1'],
        publicScopeValidated: false,
        citationCount: 1,
      },
    });
    expect(JSON.stringify(auditService.log.mock.calls)).not.toContain(
      'How do we use Kafka?',
    );
    expect(queryAuditRepo.recordQuery).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      queryHash: expect.stringMatching(/^sha256:/),
      retrievalMode: 'high_completeness',
      authorizedCapsuleCount: 1,
      metadata: {
        origin: 'knowledge_query',
        // Recorded so the knowledge/general split is queryable from the audit
        // alone, matching what ai-chat and the MCP tool already store.
        answerMode: 'knowledge',
        spaceIds: ['space-1'],
        requestedSpaceIds: ['space-1'],
        effectiveSpaceIds: ['space-1'],
        publicScopeValidated: false,
        queryEmbeddingAvailable: false,
        candidateSourceCount: 4,
        policyCandidateSourceCount: 2,
        fallbackCandidateSourceCount: 0,
        finalAuthorizedSourceCount: 1,
        accessPolicyFallbackUsed: false,
        candidateChunkCount: 3,
        rankedCandidateCount: 3,
        authorizedChunkCount: 1,
        filteredChunkCount: 2,
        timings: {
          rewriteMs: 310.2,
          retrievalMs: 412.3,
          ttftMs: 1157.2,
          generationMs: 3240.1,
          totalMs: 3702.8,
        },
        decisionReason: 'knowledge',
        finalChunkIds: ['chunk-1'],
        finalSourcePageIds: ['page-1'],
        rankReasonsByChunk: { 'chunk-1': ['lexical'] },
        contextItems: [],
        packContextLength: 10,
        packMaxContextLength: 12000,
        answerContextLength: 20,
        answerContextHash: `sha256:${'a'.repeat(64)}`,
        retrieval: {
          attempted: true,
          candidates: [
            {
              pageId: 'page-1',
              chunkId: 'chunk-1',
              score: 0.016,
              scoreType: 'lexical',
              reasons: ['lexical'],
              stage: 'direct',
              authorizationMode: 'policy',
            },
          ],
          dropped: [],
          topK: 20,
          threshold: 0.45,
        },
        context: {
          items: [
            {
              itemId: 'chunk-1',
              pageId: 'page-1',
              text: 'Kafka backs async events.',
              tokenCount: 6,
            },
          ],
          usedTokens: 6,
          maxTokens: 3000,
          dropped: [],
        },
      },
    });
    expect(JSON.stringify(queryAuditRepo.recordQuery.mock.calls)).not.toContain(
      'How do we use Kafka?',
    );
  });

  it('returns citation links on APP_URL for external Skill consumers', async () => {
    const controller = createController({
      environmentService: {
        getAppUrl: jest.fn().mockReturnValue('https://akasha.example.com/'),
      },
      chatService: {
        isEnabledForWorkspace: jest.fn().mockReturnValue(true),
        chat: jest.fn().mockResolvedValue({
          answer: 'Use Kafka.',
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
          snippets: [
            {
              id: 'chunk-1',
              title: 'Kafka',
              text: 'Use Kafka.',
              retrievalReasons: [],
              sourceWindows: [
                {
                  sourcePageId: 'page-1',
                  title: 'Kafka',
                  url: '/p/page-1',
                  text: 'Use Kafka.',
                  sourceRange: { startOffset: 0, endOffset: 10 },
                  quoteHash: 'sha256:test',
                },
              ],
            },
          ],
        }),
      },
    });

    const result = await controller.queryKnowledge(
      { query: 'Kafka?', spaceIds: ['space-1'] },
      user(),
      workspace(),
    );

    expect(result.citations[0].url).toBe('https://akasha.example.com/p/page-1');
    expect(result.citationEvidence[0].url).toBe(
      'https://akasha.example.com/p/page-1',
    );
    expect(result.retrievedSources[0].url).toBe(
      'https://akasha.example.com/p/page-1',
    );
    expect(result.snippets[0].sourceWindows[0].url).toBe(
      'https://akasha.example.com/p/page-1',
    );
  });

  it('returns and audits a general fallback after an empty knowledge retrieval', async () => {
    const retrievalDiagnostics = {
      mode: 'high_completeness' as const,
      queryEmbeddingAvailable: true,
      candidateSourceCount: 0,
      policyCandidateSourceCount: 0,
      fallbackCandidateSourceCount: 0,
      finalAuthorizedSourceCount: 0,
      accessPolicyFallbackUsed: false,
      candidateChunkCount: 0,
      rankedCandidateCount: 0,
      authorizedChunkCount: 0,
      filteredChunkCount: 0,
    };
    const chatService = {
      isEnabledForWorkspace: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        answer: 'General answer.',
        answerMode: 'general',
        citations: [],
        retrievalDiagnostics,
      }),
    };
    const queryAuditRepo = {
      recordQuery: jest.fn().mockResolvedValue(undefined),
    };
    const controller = createController({ chatService, queryAuditRepo });

    await expect(
      controller.queryKnowledge(
        { query: 'Unknown topic?', spaceIds: ['space-1'] },
        user(),
        workspace(),
      ),
    ).resolves.toEqual({
      answer: 'General answer.',
      answerMode: 'general',
      citations: [],
    });

    expect(queryAuditRepo.recordQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        retrievalMode: 'high_completeness',
        authorizedCapsuleCount: 0,
        metadata: expect.objectContaining({
          requestedSpaceIds: ['space-1'],
          effectiveSpaceIds: ['space-1'],
          publicScopeValidated: false,
          finalAuthorizedSourceCount: 0,
          authorizedChunkCount: 0,
        }),
      }),
    );
  });

  it('requires and scopes both keys for robot queries', async () => {
    const chatService = {
      isEnabledForWorkspace: jest.fn().mockReturnValue(true),
      chat: jest.fn().mockResolvedValue({
        answer: 'Scoped answer',
        citations: [],
        retrievalDiagnostics: {
          mode: 'high_completeness',
          queryEmbeddingAvailable: false,
          candidateSourceCount: 0,
          policyCandidateSourceCount: 0,
          fallbackCandidateSourceCount: 0,
          finalAuthorizedSourceCount: 0,
          accessPolicyFallbackUsed: false,
          candidateChunkCount: 0,
          rankedCandidateCount: 0,
          authorizedChunkCount: 0,
          filteredChunkCount: 0,
        },
        retrievalScope: {
          requestedSpaceIds: ['space-1'],
          effectiveSpaceIds: [],
        },
      }),
    };
    const apiKeyService = {
      validatePublicApiKey: jest.fn().mockResolvedValue({
        apiKeyId: 'public-1',
        spaceIds: ['space-1'],
      }),
    };
    const queryAuditRepo = {
      recordQuery: jest.fn().mockResolvedValue(undefined),
    };
    const controller = createController({
      chatService,
      apiKeyService,
      queryAuditRepo,
    });
    const personalUser = withApiKeyAccess(user(), {
      apiKeyId: 'personal-1',
      personalSpaceId: null,
    });

    await expect(
      controller.queryKnowledge(
        {
          type: KnowledgeQueryType.ROBOT,
          query: 'Scoped query',
          spaceIds: ['space-1'],
        },
        personalUser,
        workspace(),
        'public-token',
      ),
    ).resolves.toEqual(expect.objectContaining({ answer: 'Scoped answer' }));

    expect(apiKeyService.validatePublicApiKey).toHaveBeenCalledWith(
      'public-token',
      'workspace-1',
    );
    expect(chatService.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        spaceIds: ['space-1'],
      }),
    );
    expect(queryAuditRepo.recordQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          requestedSpaceIds: ['space-1'],
          effectiveSpaceIds: [],
          publicScopeValidated: true,
        }),
      }),
    );
  });

  it('rejects robot queries when a requested Space is outside the public key', async () => {
    const apiKeyService = {
      validatePublicApiKey: jest.fn().mockResolvedValue({
        apiKeyId: 'public-1',
        spaceIds: ['space-1'],
      }),
    };
    const chatService = {
      isEnabledForWorkspace: jest.fn().mockReturnValue(true),
      chat: jest.fn(),
    };
    const controller = createController({ chatService, apiKeyService });

    await expect(
      controller.queryKnowledge(
        {
          type: KnowledgeQueryType.ROBOT,
          query: 'Out of scope',
          spaceIds: ['space-2'],
        },
        withApiKeyAccess(user(), {
          apiKeyId: 'personal-1',
          personalSpaceId: null,
        }),
        workspace(),
        'public-token',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(chatService.chat).not.toHaveBeenCalled();
  });

  it('rejects robot queries authenticated only by a session', async () => {
    const controller = createController({
      apiKeyService: {
        validatePublicApiKey: jest.fn(),
      },
    });

    await expect(
      controller.queryKnowledge(
        {
          type: KnowledgeQueryType.ROBOT,
          query: 'Session only',
          spaceIds: ['space-1'],
        },
        user(),
        workspace(),
        'public-token',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an empty Public API key header for user queries', async () => {
    const chatService = {
      isEnabledForWorkspace: jest.fn().mockReturnValue(true),
      chat: jest.fn(),
    };
    const controller = createController({ chatService });

    await expect(
      controller.queryKnowledge(
        {
          type: KnowledgeQueryType.USER,
          query: 'User query',
          spaceIds: ['space-1'],
        },
        user(),
        workspace(),
        '',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chatService.chat).not.toHaveBeenCalled();
  });

  it('reads the complete ACL-authorized shared Page by its internal URL', async () => {
    const page = {
      id: 'page-1',
      slugId: 'kafka-guide',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Kafka Guide',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Kafka Guide' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Use Kafka for async events.' }],
          },
        ],
      },
      deletedAt: null,
      updatedAt: new Date('2026-07-29T00:00:00.000Z'),
    };
    const pageRepo = { findById: jest.fn().mockResolvedValue(page) };
    const pageAccessService = {
      validateCanReadCitationSourceWithPermissions: jest
        .fn()
        .mockResolvedValue({
          canEdit: false,
          hasRestriction: false,
        }),
    };
    const auditService = { log: jest.fn() };
    const controller = createController({
      pageRepo,
      pageAccessService,
      auditService,
    });

    await expect(
      controller.getCitationPage(
        { pageUrl: '/p/kafka-guide' },
        user(),
        workspace(),
      ),
    ).resolves.toEqual({
      pageId: 'page-1',
      spaceId: 'space-1',
      title: 'Kafka Guide',
      url: '/p/kafka-guide',
      content: '# Kafka Guide\n\nUse Kafka for async events.',
      updatedAt: new Date('2026-07-29T00:00:00.000Z'),
    });
    expect(pageRepo.findById).toHaveBeenCalledWith('kafka-guide', {
      includeContent: true,
    });
    expect(
      pageAccessService.validateCanReadCitationSourceWithPermissions,
    ).toHaveBeenCalledWith(page, expect.objectContaining({ id: 'user-1' }));
    expect(auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.KNOWLEDGE_CITATION_PAGE_READ,
      resourceType: AuditResource.PAGE,
      resourceId: 'page-1',
      spaceId: 'space-1',
      metadata: {
        origin: 'citation_page_url',
        pageUrl: '/p/kafka-guide',
      },
    });
    expect(JSON.stringify(auditService.log.mock.calls)).not.toContain(
      'Use Kafka for async events.',
    );
  });

  it.each([
    '/p/',
    'https://example.com/p/kafka-guide',
    '/p/kafka-guide?download=1',
    '/p/kafka-guide#details',
    '/p/kafka-guide/child',
  ])('rejects invalid shared Page URL %s before lookup', async (pageUrl) => {
    const pageRepo = { findById: jest.fn() };
    const controller = createController({ pageRepo });

    await expect(
      controller.getCitationPage({ pageUrl }, user(), workspace()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(pageRepo.findById).not.toHaveBeenCalled();
  });

  it('hides shared Pages outside the authenticated workspace', async () => {
    const pageAccessService = {
      validateCanReadCitationSourceWithPermissions: jest.fn(),
    };
    const controller = createController({
      pageRepo: {
        findById: jest.fn().mockResolvedValue({
          id: 'page-other',
          slugId: 'other-page',
          workspaceId: 'workspace-other',
          deletedAt: null,
        }),
      },
      pageAccessService,
    });

    await expect(
      controller.getCitationPage(
        { pageUrl: '/p/other-page' },
        user(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      pageAccessService.validateCanReadCitationSourceWithPermissions,
    ).not.toHaveBeenCalled();
  });

  it('propagates Page ACL denial without falling back to another read path', async () => {
    const pageRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'page-private',
        slugId: 'private-page',
        workspaceId: 'workspace-1',
        spaceId: 'space-private',
        deletedAt: null,
      }),
    };
    const pageAccessService = {
      validateCanReadCitationSourceWithPermissions: jest
        .fn()
        .mockRejectedValue(new ForbiddenException()),
    };
    const auditService = { log: jest.fn() };
    const controller = createController({
      pageRepo,
      pageAccessService,
      auditService,
    });

    await expect(
      controller.getCitationPage(
        { pageUrl: '/p/private-page' },
        user(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pageRepo.findById).toHaveBeenCalledTimes(1);
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('returns an authorized knowledge graph for the selected space', async () => {
    const graphService = {
      getSpaceGraph: jest.fn().mockResolvedValue({
        nodes: [{ id: 'kp-1', title: 'Kafka', spaceId: 'space-1', degree: 1 }],
        edges: [],
      }),
    };
    const controller = createController({ graphService });

    await expect(
      controller.getGraph(
        { spaceId: 'space-1', limit: 200 },
        user(),
        workspace(),
      ),
    ).resolves.toEqual({
      nodes: [{ id: 'kp-1', title: 'Kafka', spaceId: 'space-1', degree: 1 }],
      edges: [],
    });

    expect(graphService.getSpaceGraph).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      spaceId: 'space-1',
      limit: 200,
    });
  });

  it('rejects graph reads when workspace AI knowledge chat is disabled', async () => {
    const graphService = {
      getSpaceGraph: jest.fn(),
    };
    const controller = createController({
      graphService,
      chatService: { isEnabledForWorkspace: jest.fn().mockReturnValue(false) },
    });

    await expect(
      controller.getGraph({ spaceId: 'space-1' }, user(), workspace()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(graphService.getSpaceGraph).not.toHaveBeenCalled();
  });

  it('creates or coalesces durable runs without directly writing Redis', async () => {
    const knowledgeQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = {
      log: jest.fn(),
    };
    const spaceCompilation = {
      requestRuns: jest.fn().mockResolvedValue([
        {
          disposition: 'created',
          run: { id: 'run-1', spaceId: 'space-1' },
        },
        {
          disposition: 'rerun_requested',
          run: { id: 'run-2', spaceId: 'space-2' },
        },
      ]),
    };
    const controller = createController({
      knowledgeQueue,
      auditService,
      spaceCompilation,
    });

    await expect(
      controller.compileSpaces(
        { spaceIds: ['space-1', 'space-2'] },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      requestedSpaceCount: 2,
      acceptedRunCount: 2,
      coalescedRunCount: 0,
      rerunRequestedCount: 1,
      runs: [
        { spaceId: 'space-1', runId: 'run-1', disposition: 'created' },
        {
          spaceId: 'space-2',
          runId: 'run-2',
          disposition: 'rerun_requested',
        },
      ],
    });

    expect(spaceCompilation.requestRuns).toHaveBeenCalledWith([
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        scanRemovedSources: true,
      },
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-2',
        trigger: 'manual_compile',
        scanRemovedSources: true,
      },
    ]);
    expect(knowledgeQueue.add).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: 'workspace-1',
      metadata: {
        spaceIds: ['space-1', 'space-2'],
        acceptedRunCount: 2,
        coalescedRunCount: 0,
        rerunRequestedCount: 1,
      },
    });
  });

  it('publishes an editable page through an immediate page-scoped run', async () => {
    const auditService = { log: jest.fn() };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        deletedAt: null,
      }),
    };
    const pageAccessService = {
      validateCanEdit: jest.fn().mockResolvedValue({ hasRestriction: false }),
    };
    const spaceCompilation = {
      requestImmediatePagePublish: jest.fn().mockResolvedValue({
        disposition: 'created',
        run: {
          id: 'run-1',
          spaceId: 'space-1',
          knowledgeGeneration: 7,
        },
      }),
    };
    const controller = createController({
      auditService,
      pageRepo,
      pageAccessService,
      spaceCompilation,
    });

    await expect(
      controller.publishPageKnowledge(
        '11111111-1111-4111-8111-111111111111',
        user(),
        workspace(),
      ),
    ).resolves.toEqual({
      pageId: '11111111-1111-4111-8111-111111111111',
      spaceId: 'space-1',
      runId: 'run-1',
      disposition: 'created',
      mode: 'incremental',
      knowledgeGeneration: 7,
      indexMode: 'compiled',
    });

    expect(pageAccessService.validateCanEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
      }),
      user(),
    );
    expect(spaceCompilation.requestImmediatePagePublish).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: '11111111-1111-4111-8111-111111111111',
      indexMode: 'compiled',
      updatedBy: 'user-1',
    });
    expect(auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.PAGE,
      resourceId: '11111111-1111-4111-8111-111111111111',
      spaceId: 'space-1',
      metadata: {
        origin: 'manual_page_publish',
        runId: 'run-1',
        disposition: 'created',
        priority: 0,
        indexMode: 'compiled',
      },
    });
  });

  it('rejects immediate publish while the page cooldown is active', async () => {
    const cacheManager = {
      get: jest
        .fn()
        .mockResolvedValue({ step: 1, expiresAt: Date.now() + 60_000 }),
      set: jest.fn(),
      del: jest.fn(),
    };
    const requestImmediatePagePublish = jest.fn();
    const controller = createController({
      cacheManager,
      spaceCompilation: { requestImmediatePagePublish },
      pageRepo: {
        findById: jest.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          deletedAt: null,
        }),
      },
    });

    await expect(
      controller.publishPageKnowledge(
        '11111111-1111-4111-8111-111111111111',
        user(),
        workspace(),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'Page publish is cooling down',
      }),
      status: 429,
    });
    expect(requestImmediatePagePublish).not.toHaveBeenCalled();
  });

  it('returns and clears an expired final publish cooldown', async () => {
    const cacheManager = {
      get: jest.fn().mockResolvedValue({ step: 3, expiresAt: Date.now() - 1 }),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const controller = createController({ cacheManager });

    await expect(
      controller.getPagePublishCooldown('11111111-1111-4111-8111-111111111111'),
    ).resolves.toEqual({ expiresAt: null, step: 0 });
    expect(cacheManager.del).toHaveBeenCalled();
  });

  it('queues admin space actions with explicit operational job ids', async () => {
    const knowledgeQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const controller = createController({ knowledgeQueue });

    await expect(
      controller.runAdminSpaceAction(
        { action: 'reindex_access', spaceIds: ['space-1'] },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      action: 'reindex_access',
      queuedSpaceCount: 1,
      jobIds: [
        expect.stringMatching(
          /^knowledge-reindex-access__workspace-1__space-1__/,
        ),
      ],
    });

    await controller.runAdminSpaceAction(
      { action: 'mark_stale', spaceIds: ['space-1'] },
      adminUser(),
      workspace(),
    );
    await controller.runAdminSpaceAction(
      {
        action: 'rebuild_embeddings',
        spaceIds: ['space-1'],
        embeddingConcurrency: 4,
      },
      adminUser(),
      workspace(),
    );

    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace-1', spaceId: 'space-1' },
      expect.objectContaining({
        jobId: expect.stringMatching(
          /^knowledge-reindex-access__workspace-1__space-1__/,
        ),
      }),
    );
    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      { workspaceId: 'workspace-1', spaceId: 'space-1' },
      expect.objectContaining({
        jobId: expect.stringMatching(
          /^knowledge-mark-stale__workspace-1__space-1__/,
        ),
      }),
    );
    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        embeddingConcurrency: 4,
      },
      expect.objectContaining({
        jobId: 'knowledge-rebuild-embeddings__workspace-1__space-1',
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    expect(knowledgeQueue.add).not.toHaveBeenCalledWith(
      'knowledge-compile-space',
      expect.objectContaining({ trigger: 'rebuild_embeddings' }),
      expect.anything(),
    );
  });

  it('does not turn a Space retry action into a full Space compile', async () => {
    const knowledgeQueue = { add: jest.fn() };
    const controller = createController({ knowledgeQueue: knowledgeQueue });

    await expect(
      controller.runAdminSpaceAction(
        { action: 'retry_compile', spaceIds: ['space-1'] },
        adminUser(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(knowledgeQueue.add).not.toHaveBeenCalled();
  });

  it('rejects admin space actions from workspace members', async () => {
    const knowledgeQueue = {
      add: jest.fn(),
    };
    const controller = createController({ knowledgeQueue });

    await expect(
      controller.runAdminSpaceAction(
        { action: 'reindex_access', spaceIds: ['space-1'] },
        user(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(knowledgeQueue.add).not.toHaveBeenCalled();
  });

  it('scopes the scalable Run summary to readable Spaces and hides global queues from admins', async () => {
    const diagnosticsService = {
      findWorkspaceSpaceIds: jest
        .fn()
        .mockResolvedValue(['space-readable', 'space-private']),
      getRunDiagnosticsSummary: jest.fn().mockResolvedValue({
        activeRunCount: 1,
      }),
    };
    const spaceAuthorization = {
      filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-readable']),
    };
    const controller = createController({
      diagnosticsService,
      spaceAuthorization,
    });

    await expect(
      controller.getRunDiagnosticsSummary({}, adminUser(), workspace()),
    ).resolves.toEqual({ activeRunCount: 1 });
    expect(diagnosticsService.getRunDiagnosticsSummary).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-readable'],
      enforceSpaceScope: true,
      canViewGlobalQueues: false,
    });
  });

  it('scopes delayed page diagnostics to readable Spaces', async () => {
    const diagnosticsService = {
      findWorkspaceSpaceIds: jest
        .fn()
        .mockResolvedValue(['space-readable', 'space-private']),
      listDelayedPageDiagnostics: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
      }),
    };
    const controller = createController({
      diagnosticsService,
      spaceAuthorization: {
        filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-readable']),
      },
    });

    await expect(
      controller.getDelayedPageDiagnostics(
        { statuses: ['waiting'], page: 1, limit: 50 },
        user(),
        workspace(),
      ),
    ).resolves.toEqual({ items: [], total: 0 });
    expect(diagnosticsService.listDelayedPageDiagnostics).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-readable'],
      enforceSpaceScope: true,
      statuses: ['waiting'],
      search: undefined,
      page: 1,
      limit: 50,
    });
  });

  it('immediately compiles a delayed page only after exact-name confirmation', async () => {
    const auditService = { log: jest.fn() };
    const spaceCompilation = {
      requestImmediateDelayedPageCompilation: jest.fn().mockResolvedValue({
        scheduleId: '11111111-1111-4111-8111-111111111111',
        sourcePageId: 'page-1',
        spaceId: 'space-1',
        pageName: 'BeeGFS deployment',
      }),
    };
    const controller = createController({ auditService, spaceCompilation });

    await expect(
      controller.immediatelyCompileDelayedPage(
        '11111111-1111-4111-8111-111111111111',
        { confirmationPageName: 'BeeGFS deployment' },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      accepted: true,
      scheduleId: '11111111-1111-4111-8111-111111111111',
      sourcePageId: 'page-1',
      spaceId: 'space-1',
    });
    expect(
      spaceCompilation.requestImmediateDelayedPageCompilation,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      scheduleId: '11111111-1111-4111-8111-111111111111',
      confirmationPageName: 'BeeGFS deployment',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          action: 'immediate_compile_delayed_page',
        }),
      }),
    );
  });

  it('rejects immediate delayed-page compilation for non-admin users', async () => {
    const spaceCompilation = {
      requestImmediateDelayedPageCompilation: jest.fn(),
    };
    const controller = createController({ spaceCompilation });

    await expect(
      controller.immediatelyCompileDelayedPage(
        '11111111-1111-4111-8111-111111111111',
        { confirmationPageName: 'BeeGFS deployment' },
        user(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      spaceCompilation.requestImmediateDelayedPageCompilation,
    ).not.toHaveBeenCalled();
  });

  it('removes a confirmed delayed page and records an audit event', async () => {
    const auditService = { log: jest.fn() };
    const spaceCompilation = {
      removeDelayedPageCompilation: jest.fn().mockResolvedValue({
        scheduleId: '11111111-1111-4111-8111-111111111111',
        sourcePageId: 'page-1',
        spaceId: 'space-1',
        pageName: 'BeeGFS deployment',
      }),
    };
    const controller = createController({ auditService, spaceCompilation });

    await expect(
      controller.removeDelayedPageFromQueue(
        '11111111-1111-4111-8111-111111111111',
        { confirmationPageName: 'BeeGFS deployment' },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      removed: true,
      scheduleId: '11111111-1111-4111-8111-111111111111',
      sourcePageId: 'page-1',
      spaceId: 'space-1',
    });
    expect(spaceCompilation.removeDelayedPageCompilation).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      scheduleId: '11111111-1111-4111-8111-111111111111',
      confirmationPageName: 'BeeGFS deployment',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AuditEvent.KNOWLEDGE_DELAYED_PAGE_REMOVED,
        metadata: expect.objectContaining({
          action: 'remove_delayed_page_from_queue',
        }),
      }),
    );
  });

  it('rejects delayed-page removal for non-admin users', async () => {
    const spaceCompilation = {
      removeDelayedPageCompilation: jest.fn(),
    };
    const controller = createController({ spaceCompilation });

    await expect(
      controller.removeDelayedPageFromQueue(
        '11111111-1111-4111-8111-111111111111',
        { confirmationPageName: 'BeeGFS deployment' },
        user(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      spaceCompilation.removeDelayedPageCompilation,
    ).not.toHaveBeenCalled();
  });

  it('does not reveal a RunPage detail outside the readable Space scope', async () => {
    const diagnosticsService = {
      findRunDiagnosticSpaceId: jest.fn().mockResolvedValue('space-private'),
      listRunPageDiagnostics: jest.fn(),
    };
    const controller = createController({
      diagnosticsService,
      spaceAuthorization: {
        filterReadableSpaceIds: jest.fn().mockResolvedValue([]),
      },
    });

    await expect(
      controller.getRunPageDiagnostics(
        '11111111-1111-4111-8111-111111111111',
        { page: 1, limit: 50 },
        user(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(diagnosticsService.listRunPageDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ allowedSpaceIds: [] }),
    );
  });

  it('restricts approximate worker capacity to workspace owners', async () => {
    const diagnosticsService = { getWorkerDiagnostics: jest.fn() };
    const controller = createController({ diagnosticsService });

    await expect(
      controller.getKnowledgeWorkerDiagnostics(adminUser(), workspace()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(diagnosticsService.getWorkerDiagnostics).not.toHaveBeenCalled();
  });

  it('loads quality on demand only for readable Spaces', async () => {
    const diagnosticsService = {
      findWorkspaceSpaceIds: jest
        .fn()
        .mockResolvedValue(['space-readable', 'space-private']),
      getQualityDiagnostics: jest.fn().mockResolvedValue({ summary: {} }),
    };
    const controller = createController({
      diagnosticsService,
      spaceAuthorization: {
        filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-readable']),
      },
    });

    await controller.getQualityDiagnostics({}, user(), workspace());

    expect(diagnosticsService.getQualityDiagnostics).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-readable'],
    });
  });

  it('restricts quarantine and retrieval diagnostics to workspace owners', async () => {
    const diagnosticsService = {
      listQuarantineDiagnostics: jest.fn(),
      getRetrievalDiagnostics: jest.fn(),
    };
    const controller = createController({ diagnosticsService });

    await expect(
      controller.getQuarantineDiagnostics({}, adminUser(), workspace()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.getRetrievalDiagnostics(adminUser(), workspace()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(diagnosticsService.listQuarantineDiagnostics).not.toHaveBeenCalled();
    expect(diagnosticsService.getRetrievalDiagnostics).not.toHaveBeenCalled();
  });

  it('paginates owner quarantine diagnostics inside the requested Space scope', async () => {
    const diagnosticsService = {
      findWorkspaceSpaceIds: jest.fn().mockResolvedValue(['space-1']),
      listQuarantineDiagnostics: jest.fn().mockResolvedValue({ items: [] }),
    };
    const controller = createController({ diagnosticsService });

    await controller.getQuarantineDiagnostics(
      { spaceIds: ['space-1'], page: 2, limit: 20 },
      ownerUser(),
      workspace(),
    );

    expect(diagnosticsService.listQuarantineDiagnostics).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      page: 2,
      limit: 20,
    });
  });

  it('retries selected pages by requesting one durable Run per Space', async () => {
    const pageRepo = {
      findExistingPageRefs: jest.fn().mockResolvedValue([
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          deletedAt: null,
        },
        {
          id: 'page-2',
          workspaceId: 'workspace-1',
          spaceId: 'space-2',
          deletedAt: null,
        },
      ]),
    };
    const spaceCompilation = {
      requestRuns: jest.fn().mockResolvedValue([
        { disposition: 'created', run: { id: 'run-space-1' } },
        { disposition: 'coalesced', run: { id: 'run-space-2' } },
      ]),
      clearImageExtractionCache: jest.fn().mockResolvedValue(3),
      findSpaceIdsWithActiveRun: jest.fn().mockResolvedValue([]),
    };
    const controller = createController({
      pageRepo,
      spaceCompilation,
      diagnosticsService: {
        findCompiledPageIds: jest.fn().mockResolvedValue(['page-1', 'page-2']),
      },
    });

    await expect(
      controller.retryPages(
        { pageIds: ['page-1', 'page-2', 'page-1'] },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      queuedPageCount: 2,
      jobIds: ['run-space-1', 'run-space-2'],
    });

    expect(spaceCompilation.requestRuns).toHaveBeenCalledWith([
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'page_retry',
        targetSourcePageIds: ['page-1'],
      },
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-2',
        trigger: 'page_retry',
        targetSourcePageIds: ['page-2'],
      },
    ]);
    expect(spaceCompilation).not.toHaveProperty('resetGenerationAttemptBudget');
    expect(spaceCompilation.clearImageExtractionCache).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
  });

  it('rejects a retry selection when a page has never been compiled', async () => {
    const pageRepo = {
      findExistingPageRefs: jest.fn().mockResolvedValue([
        {
          id: 'page-failed',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          deletedAt: null,
        },
        {
          id: 'page-succeeded',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          deletedAt: null,
        },
      ]),
    };
    const sourceExporter = { exportPageSources: jest.fn() };
    const spaceCompilation = { requestRuns: jest.fn() };
    const controller = createController({
      pageRepo,
      sourceExporter,
      spaceCompilation,
      diagnosticsService: {
        findCompiledPageIds: jest.fn().mockResolvedValue(['page-failed']),
      },
    });

    await expect(
      controller.retryPages(
        { pageIds: ['page-failed', 'page-succeeded'] },
        adminUser(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(sourceExporter.exportPageSources).not.toHaveBeenCalled();
    expect(spaceCompilation.requestRuns).not.toHaveBeenCalled();
  });

  it('refuses a retry while a Space Run is still in progress, before mutating', async () => {
    const pageRepo = {
      findExistingPageRefs: jest.fn().mockResolvedValue([
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          deletedAt: null,
        },
        {
          id: 'page-2',
          workspaceId: 'workspace-1',
          spaceId: 'space-2',
          deletedAt: null,
        },
      ]),
    };
    const sourceExporter = { exportPageSources: jest.fn() };
    const diagnosticsService = {
      findCompiledPageIds: jest.fn().mockResolvedValue(['page-1', 'page-2']),
    };
    const spaceCompilation = {
      requestRuns: jest.fn(),
      clearImageExtractionCache: jest.fn(),
      // space-2 still has a live Run; the whole retry must be refused.
      findSpaceIdsWithActiveRun: jest.fn().mockResolvedValue(['space-2']),
    };
    const controller = createController({
      pageRepo,
      diagnosticsService,
      sourceExporter,
      spaceCompilation,
    });

    await expect(
      controller.retryPages(
        { pageIds: ['page-1', 'page-2'] },
        adminUser(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(spaceCompilation.findSpaceIdsWithActiveRun).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1', 'space-2'],
    });
    // No mutation may run once the guard trips.
    expect(spaceCompilation.clearImageExtractionCache).not.toHaveBeenCalled();
    expect(spaceCompilation.requestRuns).not.toHaveBeenCalled();
    expect(sourceExporter.exportPageSources).not.toHaveBeenCalled();
  });

  it('rejects page retries from workspace members before reading or queueing pages', async () => {
    const pageRepo = { findExistingPageRefs: jest.fn() };
    const diagnosticsService = { findCompiledPageIds: jest.fn() };
    const sourceExporter = { exportPageSources: jest.fn() };
    const spaceCompilation = { requestRuns: jest.fn() };
    const controller = createController({
      pageRepo,
      diagnosticsService,
      sourceExporter,
      spaceCompilation,
    });

    await expect(
      controller.retryPages({ pageIds: ['page-1'] }, user(), workspace()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(pageRepo.findExistingPageRefs).not.toHaveBeenCalled();
    expect(diagnosticsService.findCompiledPageIds).not.toHaveBeenCalled();
    expect(sourceExporter.exportPageSources).not.toHaveBeenCalled();
    expect(spaceCompilation.requestRuns).not.toHaveBeenCalled();
  });

  it('delegates a model config test to the test service for admins', async () => {
    const aiModelConfigTestService = {
      testConfig: jest.fn().mockResolvedValue({ ok: true, latencyMs: 42 }),
    };
    const controller = createController({ aiModelConfigTestService });

    await expect(
      controller.testModelConfig(
        'answer',
        { provider: 'openai-compatible', model: 'qwen-max' } as never,
        adminUser(),
      ),
    ).resolves.toEqual({ ok: true, latencyMs: 42 });

    expect(aiModelConfigTestService.testConfig).toHaveBeenCalledWith(
      'answer',
      expect.objectContaining({
        provider: 'openai-compatible',
        model: 'qwen-max',
      }),
    );
  });

  it('rejects a model config test from workspace members before testing', async () => {
    const aiModelConfigTestService = { testConfig: jest.fn() };
    const controller = createController({ aiModelConfigTestService });

    await expect(
      controller.testModelConfig(
        'answer',
        { provider: 'openai-compatible', model: 'qwen-max' } as never,
        user(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(aiModelConfigTestService.testConfig).not.toHaveBeenCalled();
  });

  it('rejects a model config test for an unknown feature', async () => {
    const aiModelConfigTestService = { testConfig: jest.fn() };
    const controller = createController({ aiModelConfigTestService });

    await expect(
      controller.testModelConfig(
        'bogus',
        { provider: 'openai-compatible', model: 'qwen-max' } as never,
        adminUser(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(aiModelConfigTestService.testConfig).not.toHaveBeenCalled();
  });

  describe('single-Space knowledge operations', () => {
    it('updates exactly one Space only after exact-name confirmation', async () => {
      const spaceCompilation = {
        requestRuns: jest.fn().mockResolvedValue([
          {
            disposition: 'created',
            run: {
              id: 'run-1',
              mode: 'incremental',
              knowledgeGeneration: 4,
            },
          },
        ]),
      };
      const knowledgeQueue = { add: jest.fn() };
      const auditService = { log: jest.fn() };
      const controller = createController({
        spaceCompilation,
        knowledgeQueue,
        auditService,
      });

      await expect(
        controller.updateSpaceKnowledge(
          '11111111-1111-4111-8111-111111111111',
          { confirmationSpaceName: 'AIM-运维-公共文档' },
          adminUser(),
          workspace(),
        ),
      ).resolves.toEqual({
        runId: 'run-1',
        mode: 'incremental',
        knowledgeGeneration: 4,
      });

      expect(spaceCompilation.requestRuns).toHaveBeenCalledWith([
        expect.objectContaining({
          workspaceId: 'workspace-1',
          spaceId: '11111111-1111-4111-8111-111111111111',
          confirmationSpaceName: 'AIM-运维-公共文档',
          scanRemovedSources: true,
        }),
      ]);
      expect(knowledgeQueue.add).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: '11111111-1111-4111-8111-111111111111',
          metadata: expect.objectContaining({
            mode: 'incremental',
            runId: 'run-1',
            knowledgeGeneration: 4,
          }),
        }),
      );
      expect(JSON.stringify(auditService.log.mock.calls)).not.toContain(
        'AIM-运维-公共文档',
      );
    });

    it('rejects a wrong or stale confirmation without queueing work or auditing success', async () => {
      const mismatch = new ConflictException(
        'Space name confirmation no longer matches.',
      );
      const spaceCompilation = {
        requestRuns: jest.fn().mockRejectedValue(mismatch),
      };
      const knowledgeQueue = { add: jest.fn() };
      const auditService = { log: jest.fn() };
      const controller = createController({
        spaceCompilation,
        knowledgeQueue,
        auditService,
      });

      await expect(
        controller.updateSpaceKnowledge(
          '11111111-1111-4111-8111-111111111111',
          { confirmationSpaceName: ' AIM-运维-公共文档' },
          adminUser(),
          workspace(),
        ),
      ).rejects.toBe(mismatch);

      expect(knowledgeQueue.add).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('force rebuilds through the destructive service and does not accept a client mode', async () => {
      const spaceReset = {
        forceRebuild: jest.fn().mockResolvedValue({
          run: { id: 'force-run-1', mode: 'force_rebuild' },
          generation: 9,
        }),
      };
      const knowledgeQueue = { add: jest.fn() };
      const controller = createController({
        spaceReset,
        knowledgeQueue,
      });

      await expect(
        controller.forceRebuildSpaceKnowledge(
          '11111111-1111-4111-8111-111111111111',
          {
            confirmationSpaceName: 'AIM-运维-公共文档',
            mode: 'incremental',
          } as never,
          adminUser(),
          workspace(),
        ),
      ).resolves.toEqual({
        runId: 'force-run-1',
        mode: 'force_rebuild',
        knowledgeGeneration: 9,
      });

      expect(spaceReset.forceRebuild).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'workspace-1',
          spaceId: '11111111-1111-4111-8111-111111111111',
          confirmationSpaceName: 'AIM-运维-公共文档',
        }),
      );
      expect(knowledgeQueue.add).not.toHaveBeenCalled();
    });

    it('rejects both operations for non-admin users before export or queueing', async () => {
      const knowledgeQueue = { add: jest.fn() };
      const controller = createController({ knowledgeQueue });

      await expect(
        controller.updateSpaceKnowledge(
          '11111111-1111-4111-8111-111111111111',
          { confirmationSpaceName: 'Space' },
          user(),
          workspace(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        controller.forceRebuildSpaceKnowledge(
          '11111111-1111-4111-8111-111111111111',
          { confirmationSpaceName: 'Space' },
          user(),
          workspace(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(knowledgeQueue.add).not.toHaveBeenCalled();
    });
  });
});

function createController(
  overrides: {
    chatService?: Partial<AiKnowledgeChatService>;
    auditService?: Partial<IAuditService>;
    citationImageResolver?: Partial<KnowledgeCitationImageResolverService>;
    diagnosticsService?: Partial<KnowledgeDiagnosticsService>;
    graphService?: Partial<KnowledgeGraphService>;
    queryAuditRepo?: Partial<KnowledgeQueryAuditRepo>;
    knowledgeQueue?: { add: jest.Mock };
    pageRepo?: Partial<PageRepo>;
    sourceExporter?: Partial<KnowledgeSourceExporterService>;
    spaceCompilation?: Partial<KnowledgeSpaceCompilationService>;
    spaceReset?: Partial<KnowledgeSpaceResetService>;
    spaceAuthorization?: Partial<SpaceAuthorizationService>;
    pageAccessService?: Partial<PageAccessService>;
    aiModelConfigService?: Partial<AiModelConfigService>;
    aiModelConfigTestService?: Partial<AiModelConfigTestService>;
    apiKeyService?: Partial<ApiKeyService>;
    environmentService?: Partial<EnvironmentService>;
    cacheManager?: { get: jest.Mock; set?: jest.Mock; del?: jest.Mock };
  } = {},
) {
  return new LlmWikiController(
    {
      isEnabledForWorkspace: jest.fn().mockReturnValue(true),
      chat: jest.fn(),
      ...overrides.chatService,
    } as unknown as AiKnowledgeChatService,
    {
      resolveImagesForCitations: jest.fn(
        async ({ citations }: { citations: Array<Record<string, unknown>> }) =>
          citations.map((citation) => ({ ...citation, images: [] })),
      ),
      ...overrides.citationImageResolver,
    } as unknown as KnowledgeCitationImageResolverService,
    {
      log: jest.fn(),
      ...overrides.auditService,
    } as unknown as IAuditService,
    {
      findWorkspaceSpaceIds: jest.fn().mockResolvedValue([]),
      getRunDiagnosticsSummary: jest.fn(),
      listRunDiagnostics: jest.fn(),
      listDelayedPageDiagnostics: jest.fn(),
      findRunDiagnosticSpaceId: jest.fn(),
      listRunPageDiagnostics: jest.fn(),
      getWorkerDiagnostics: jest.fn(),
      getQualityDiagnostics: jest.fn(),
      listQuarantineDiagnostics: jest.fn(),
      getRetrievalDiagnostics: jest.fn(),
      findCompiledPageIds: jest
        .fn()
        .mockImplementation(({ sourcePageIds }) => sourcePageIds),
      ...overrides.diagnosticsService,
    } as unknown as KnowledgeDiagnosticsService,
    {
      getSpaceGraph: jest.fn(),
      ...overrides.graphService,
    } as unknown as KnowledgeGraphService,
    {
      recordQuery: jest.fn(),
      ...overrides.queryAuditRepo,
    } as unknown as KnowledgeQueryAuditRepo,
    {
      add: jest.fn(),
      ...overrides.knowledgeQueue,
    } as never,
    {
      findExistingPageRefs: jest.fn().mockResolvedValue([]),
      ...overrides.pageRepo,
    } as unknown as PageRepo,
    {
      exportPageSources: jest.fn().mockResolvedValue([]),
      ...overrides.sourceExporter,
    } as unknown as KnowledgeSourceExporterService,
    {
      requestRuns: jest.fn(),
      requestImmediatePagePublish: jest.fn(),
      clearImageExtractionCache: jest.fn().mockResolvedValue(0),
      findSpaceIdsWithActiveRun: jest.fn().mockResolvedValue([]),
      ...overrides.spaceCompilation,
    } as unknown as KnowledgeSpaceCompilationService,
    {
      forceRebuild: jest.fn(),
      ...overrides.spaceReset,
    } as unknown as KnowledgeSpaceResetService,
    {
      filterReadableSpaceIds: jest
        .fn()
        .mockImplementation(({ spaceIds }) => spaceIds),
      ...overrides.spaceAuthorization,
    } as unknown as SpaceAuthorizationService,
    {
      validateCanReadCitationSourceWithPermissions: jest.fn(),
      validateCanEdit: jest.fn(),
      ...overrides.pageAccessService,
    } as unknown as PageAccessService,
    {
      listConfigViews: jest.fn().mockResolvedValue([]),
      updateConfig: jest.fn(),
      ...overrides.aiModelConfigService,
    } as unknown as AiModelConfigService,
    {
      testConfig: jest.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
      ...overrides.aiModelConfigTestService,
    } as unknown as AiModelConfigTestService,
    {
      validatePublicApiKey: jest.fn(),
      ...overrides.apiKeyService,
    } as unknown as ApiKeyService,
    overrides.environmentService as EnvironmentService | undefined,
    undefined,
    overrides.cacheManager as never,
  );
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    workspaceId: 'workspace-1',
    role: UserRole.MEMBER,
    ...overrides,
  } as unknown as User;
}

function adminUser(): User {
  return user({ role: UserRole.ADMIN });
}

function ownerUser(): User {
  return user({ role: UserRole.OWNER });
}

function workspace(): Workspace {
  return {
    id: 'workspace-1',
    licenseKey: 'license-key',
    plan: 'business',
    settings: { ai: { chat: true } },
  } as unknown as Workspace;
}
