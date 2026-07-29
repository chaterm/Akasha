import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { UserRole } from '../../common/helpers/types/permission';
import { IAuditService } from '../../integrations/audit/audit.service';
import { QueueJob } from '../../integrations/queue/constants';
import { KNOWLEDGE_COMPLETENESS_NOTICE } from './services/knowledge-retrieval.service';
import { AiKnowledgeChatService } from './services/ai-knowledge-chat.service';
import { KnowledgeImportService } from './services/knowledge-import.service';
import { LlmWikiController } from './llm-wiki.controller';
import { KnowledgeDiagnosticsService } from './services/knowledge-diagnostics.service';
import { KnowledgeGraphService } from './services/knowledge-graph.service';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { KnowledgeSourceExporterService } from './services/knowledge-source-exporter.service';
import { KnowledgeSpaceCompilationService } from './services/knowledge-space-compilation.service';
import { KnowledgeSpaceResetService } from './services/knowledge-space-reset.service';
import { SpaceAuthorizationService } from '../../core/space/services/space-authorization.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';

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

    await expect(
      controller.queryKnowledge(
        { query: 'How do we use Kafka?', spaceIds: ['space-1'] },
        user(),
        workspace(),
      ),
    ).resolves.toEqual({
      answer: 'Use Kafka for async events.',
      citations: [{ sourcePageId: 'page-1', title: 'Kafka', url: '/p/page-1' }],
      completenessNotice: KNOWLEDGE_COMPLETENESS_NOTICE,
    });

    expect(chatService.chat).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      query: 'How do we use Kafka?',
      spaceIds: ['space-1'],
      workspace: workspace(),
    });
    expect(auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.KNOWLEDGE_QUERY,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: 'workspace-1',
      metadata: {
        queryHash: expect.stringMatching(/^sha256:/),
        spaceIds: ['space-1'],
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
        spaceIds: ['space-1'],
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
    });
    expect(JSON.stringify(queryAuditRepo.recordQuery.mock.calls)).not.toContain(
      'How do we use Kafka?',
    );
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

  it('rejects compile result imports when workspace AI knowledge chat is disabled', async () => {
    const chatService = {
      isEnabledForWorkspace: jest.fn().mockReturnValue(false),
      chat: jest.fn(),
    };
    const importService = {
      importCompileResult: jest.fn(),
    };
    const controller = createController({ chatService, importService });

    await expect(
      controller.importCompileResult(
        compileResultDto(),
        adminUser(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(importService.importCompileResult).not.toHaveBeenCalled();
  });

  it('rejects compile result imports from workspace members', async () => {
    const importService = {
      importCompileResult: jest.fn(),
    };
    const controller = createController({ importService });

    await expect(
      controller.importCompileResult(
        compileResultDto(),
        user({ role: UserRole.MEMBER }),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(importService.importCompileResult).not.toHaveBeenCalled();
  });

  it('imports compile results through the database import service and audits metadata only', async () => {
    const importService = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    };
    const auditService = {
      log: jest.fn(),
    };
    const controller = createController({ importService, auditService });

    await expect(
      controller.importCompileResult(
        compileResultDto(),
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
    });

    expect(importService.importCompileResult).toHaveBeenCalledWith({
      input: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        compilerVersion: 'test-compiler',
        promptVersion: 'test-prompt',
        sources: [
          {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            contentHash: 'sha256:page-1',
            title: 'Kafka',
            text: 'Kafka backs async events.',
            references: [],
          },
        ],
      },
      artifacts: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          artifactId: '11111111-1111-4111-8111-111111111111',
          title: 'Kafka usage',
          contentMarkdown: 'Kafka backs async events.',
          sourcePageIds: ['page-1'],
          compilerVersion: 'test-compiler',
          promptVersion: 'test-prompt',
          inputSourceRefs: [
            {
              workspaceId: 'workspace-1',
              spaceId: 'space-1',
              sourcePageId: 'page-1',
              sourceVersion: 'v1',
              contentHash: 'sha256:page-1',
            },
          ],
          chunks: [
            {
              text: 'Kafka backs async events.',
              inputSourceRefs: [
                {
                  workspaceId: 'workspace-1',
                  spaceId: 'space-1',
                  sourcePageId: 'page-1',
                  sourceVersion: 'v1',
                  contentHash: 'sha256:page-1',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.KNOWLEDGE_IMPORT,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: 'space-1',
      metadata: {
        artifactCount: 1,
        sourceCount: 1,
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      },
    });
    expect(JSON.stringify(auditService.log.mock.calls)).not.toContain(
      'Kafka backs async events.',
    );
  });

  it('queues selected spaces for knowledge compilation from admins', async () => {
    const knowledgeQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = {
      log: jest.fn(),
    };
    const controller = createController({
      knowledgeQueue,
      auditService,
    });

    await expect(
      controller.compileSpaces(
        { spaceIds: ['space-1', 'space-2'] },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      queuedSpaceCount: 2,
      jobIds: [
        expect.stringMatching(
          /^knowledge-compile-space__workspace-1__space-1__/,
        ),
        expect.stringMatching(
          /^knowledge-compile-space__workspace-1__space-2__/,
        ),
      ],
    });

    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_SPACE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
      },
      expect.objectContaining({
        jobId: expect.stringMatching(
          /^knowledge-compile-space__workspace-1__space-1__/,
        ),
      }),
    );
    expect(knowledgeQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_SPACE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-2',
        trigger: 'manual_compile',
      },
      expect.objectContaining({
        jobId: expect.stringMatching(
          /^knowledge-compile-space__workspace-1__space-2__/,
        ),
      }),
    );
    expect(auditService.log).toHaveBeenCalledWith({
      event: AuditEvent.KNOWLEDGE_COMPILE_QUEUED,
      resourceType: AuditResource.KNOWLEDGE,
      resourceId: 'workspace-1',
      metadata: {
        spaceIds: ['space-1', 'space-2'],
        queuedSpaceCount: 2,
      },
    });
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
      { action: 'rebuild_embeddings', spaceIds: ['space-1'] },
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
      },
      expect.objectContaining({
        jobId: 'knowledge-rebuild-embeddings__workspace-1__space-1',
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
    expect(knowledgeQueue.add).not.toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_SPACE,
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

  it('returns knowledge diagnostics for admins', async () => {
    const diagnosticsService = {
      findWorkspaceSpaceIds: jest
        .fn()
        .mockResolvedValue(['space-1', 'space-private']),
      getWorkspaceDiagnostics: jest.fn().mockResolvedValue({
        pages: [{ pageId: 'page-1', title: 'Kafka', knowledgeChunkCount: 2 }],
        jobs: [{ id: 'job-1', name: QueueJob.KNOWLEDGE_COMPILE_SPACE }],
        compileStatuses: [],
      }),
    };
    const spaceAuthorization = {
      filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-1']),
    };
    const controller = createController({
      diagnosticsService,
      spaceAuthorization,
    });

    await expect(
      controller.getDiagnostics(
        {
          spaceIds: ['space-1'],
          statuses: ['failed'],
          stages: ['generation'],
          limit: 20,
        },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      pages: [{ pageId: 'page-1', title: 'Kafka', knowledgeChunkCount: 2 }],
      jobs: [{ id: 'job-1', name: QueueJob.KNOWLEDGE_COMPILE_SPACE }],
      compileStatuses: [],
    });

    expect(diagnosticsService.getWorkspaceDiagnostics).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      enforceSpaceScope: true,
      canViewGlobalQueues: false,
      includeDetailedDiagnostics: true,
      statuses: ['failed'],
      stages: ['generation'],
      limit: 20,
    });
    expect(spaceAuthorization.filterReadableSpaceIds).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'user-1', role: UserRole.ADMIN }),
      spaceIds: ['space-1', 'space-private'],
    });
  });

  it('allows an authorized member to see durable progress without global queue details', async () => {
    const diagnosticsService = {
      findWorkspaceSpaceIds: jest
        .fn()
        .mockResolvedValue(['space-1', 'space-2']),
      getWorkspaceDiagnostics: jest.fn().mockResolvedValue({ compileRuns: [] }),
    };
    const spaceAuthorization = {
      filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-2']),
    };
    const controller = createController({
      diagnosticsService,
      spaceAuthorization,
    });

    await expect(
      controller.getDiagnostics({}, user(), workspace()),
    ).resolves.toEqual({ compileRuns: [] });
    expect(diagnosticsService.getWorkspaceDiagnostics).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-2'],
      enforceSpaceScope: true,
      canViewGlobalQueues: false,
      includeDetailedDiagnostics: false,
      statuses: undefined,
      stages: undefined,
      limit: undefined,
    });
  });

  it('allows only the workspace owner boundary to view instance-wide queue snapshots', async () => {
    const diagnosticsService = {
      findWorkspaceSpaceIds: jest.fn().mockResolvedValue(['space-1']),
      getWorkspaceDiagnostics: jest.fn().mockResolvedValue({
        canViewGlobalQueues: true,
        includeDetailedDiagnostics: true,
      }),
    };
    const spaceAuthorization = {
      filterReadableSpaceIds: jest.fn().mockResolvedValue(['space-1']),
    };
    const controller = createController({
      diagnosticsService,
      spaceAuthorization,
    });

    await controller.getDiagnostics(
      {},
      user({ role: UserRole.OWNER }),
      workspace(),
    );

    expect(diagnosticsService.getWorkspaceDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        canViewGlobalQueues: true,
        spaceIds: ['space-1'],
        enforceSpaceScope: true,
      }),
    );
  });

  it('retries only selected pages without creating Space runs', async () => {
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
    const sourceExporter = {
      exportPageSources: jest
        .fn()
        .mockImplementation(({ spaceId, sourcePageIds }) =>
          sourcePageIds.map((sourcePageId: string) => ({
            workspaceId: 'workspace-1',
            spaceId,
            sourcePageId,
            sourceVersion: `version-${sourcePageId}`,
            contentHash: `hash-${sourcePageId}`,
            title: sourcePageId,
            text: `content-${sourcePageId}`,
            references: [],
          })),
        ),
    };
    const spaceCompilation = {
      hasActiveRun: jest.fn().mockResolvedValue(false),
      queuePageRetry: jest
        .fn()
        .mockImplementation(({ sourcePageId }) => `retry-${sourcePageId}`),
      startSpaceRun: jest.fn(),
    };
    const controller = createController({
      pageRepo,
      sourceExporter,
      spaceCompilation,
      diagnosticsService: {
        findRetryableFailedPageIds: jest
          .fn()
          .mockResolvedValue(['page-1', 'page-2']),
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
      jobIds: ['retry-page-1', 'retry-page-2'],
    });

    expect(spaceCompilation.hasActiveRun).toHaveBeenCalledTimes(2);
    expect(spaceCompilation.queuePageRetry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        contentHash: 'hash-page-1',
      }),
    );
    expect(spaceCompilation.queuePageRetry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-2',
        sourcePageId: 'page-2',
        contentHash: 'hash-page-2',
      }),
    );
    expect(spaceCompilation.startSpaceRun).not.toHaveBeenCalled();
  });

  it('rejects the complete retry selection before export when any page is not currently failed', async () => {
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
    const spaceCompilation = {
      hasActiveRun: jest.fn(),
      queuePageRetry: jest.fn(),
    };
    const controller = createController({
      pageRepo,
      sourceExporter,
      spaceCompilation,
      diagnosticsService: {
        findRetryableFailedPageIds: jest
          .fn()
          .mockResolvedValue(['page-failed']),
      },
    });

    await expect(
      controller.retryPages(
        { pageIds: ['page-failed', 'page-succeeded'] },
        adminUser(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(spaceCompilation.hasActiveRun).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(sourceExporter.exportPageSources).not.toHaveBeenCalled();
    expect(spaceCompilation.queuePageRetry).not.toHaveBeenCalled();
  });

  it('rejects all selected retries before exporting or dispatching when any Space run is active', async () => {
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
      findRetryableFailedPageIds: jest
        .fn()
        .mockResolvedValue(['page-1', 'page-2']),
    };
    const spaceCompilation = {
      hasActiveRun: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      queuePageRetry: jest.fn(),
      startSpaceRun: jest.fn(),
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

    expect(spaceCompilation.hasActiveRun).toHaveBeenCalledTimes(2);
    expect(
      diagnosticsService.findRetryableFailedPageIds,
    ).not.toHaveBeenCalled();
    expect(sourceExporter.exportPageSources).not.toHaveBeenCalled();
    expect(spaceCompilation.queuePageRetry).not.toHaveBeenCalled();
    expect(spaceCompilation.startSpaceRun).not.toHaveBeenCalled();
  });

  it('rejects page retries from workspace members before reading or queueing pages', async () => {
    const pageRepo = { findExistingPageRefs: jest.fn() };
    const diagnosticsService = { findRetryableFailedPageIds: jest.fn() };
    const sourceExporter = { exportPageSources: jest.fn() };
    const spaceCompilation = {
      hasActiveRun: jest.fn(),
      queuePageRetry: jest.fn(),
    };
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
    expect(
      diagnosticsService.findRetryableFailedPageIds,
    ).not.toHaveBeenCalled();
    expect(sourceExporter.exportPageSources).not.toHaveBeenCalled();
    expect(spaceCompilation.queuePageRetry).not.toHaveBeenCalled();
  });

  describe('single-Space knowledge operations', () => {
    it('updates exactly one Space only after exact-name confirmation', async () => {
      const sourceExporter = {
        exportSpaceSources: jest.fn().mockResolvedValue([
          {
            workspaceId: 'workspace-1',
            spaceId: '11111111-1111-4111-8111-111111111111',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            contentHash: 'sha256:page-1',
            title: 'Page 1',
            text: 'content',
            references: [],
          },
        ]),
      };
      const spaceCompilation = {
        startSpaceRun: jest.fn().mockResolvedValue({
          id: 'run-1',
          mode: 'incremental',
          knowledgeGeneration: 4,
        }),
      };
      const knowledgeQueue = { add: jest.fn() };
      const auditService = { log: jest.fn() };
      const controller = createController({
        sourceExporter,
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

      expect(spaceCompilation.startSpaceRun).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'workspace-1',
          spaceId: '11111111-1111-4111-8111-111111111111',
          mode: 'incremental',
          confirmationSpaceName: 'AIM-运维-公共文档',
          sources: expect.any(Array),
        }),
      );
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
      const sourceExporter = {
        exportSpaceSources: jest.fn().mockResolvedValue([]),
      };
      const spaceCompilation = {
        startSpaceRun: jest.fn().mockRejectedValue(mismatch),
      };
      const knowledgeQueue = { add: jest.fn() };
      const auditService = { log: jest.fn() };
      const controller = createController({
        sourceExporter,
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
      const sourceExporter = {
        exportSpaceSources: jest.fn().mockResolvedValue([]),
      };
      const spaceReset = {
        forceRebuild: jest.fn().mockResolvedValue({
          run: { id: 'force-run-1', mode: 'force_rebuild' },
          generation: 9,
        }),
      };
      const knowledgeQueue = { add: jest.fn() };
      const controller = createController({
        sourceExporter,
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
      const sourceExporter = { exportSpaceSources: jest.fn() };
      const knowledgeQueue = { add: jest.fn() };
      const controller = createController({ sourceExporter, knowledgeQueue });

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

      expect(sourceExporter.exportSpaceSources).not.toHaveBeenCalled();
      expect(knowledgeQueue.add).not.toHaveBeenCalled();
    });
  });
});

function createController(
  overrides: {
    chatService?: Partial<AiKnowledgeChatService>;
    auditService?: Partial<IAuditService>;
    importService?: Partial<KnowledgeImportService>;
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
  } = {},
) {
  return new LlmWikiController(
    {
      isEnabledForWorkspace: jest.fn().mockReturnValue(true),
      chat: jest.fn(),
      ...overrides.chatService,
    } as unknown as AiKnowledgeChatService,
    {
      log: jest.fn(),
      ...overrides.auditService,
    } as unknown as IAuditService,
    {
      importCompileResult: jest.fn(),
      ...overrides.importService,
    } as unknown as KnowledgeImportService,
    {
      getWorkspaceDiagnostics: jest.fn(),
      findRetryableFailedPageIds: jest
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
      startSpaceRun: jest.fn(),
      hasActiveRun: jest.fn().mockResolvedValue(false),
      queuePageRetry: jest.fn(),
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
      ...overrides.pageAccessService,
    } as unknown as PageAccessService,
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

function workspace(): Workspace {
  return {
    id: 'workspace-1',
    licenseKey: 'license-key',
    plan: 'business',
    settings: { ai: { chat: true } },
  } as unknown as Workspace;
}

function compileResultDto() {
  return {
    spaceId: 'space-1',
    compilerVersion: 'test-compiler',
    promptVersion: 'test-prompt',
    sources: [
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        sourceVersion: 'v1',
        contentHash: 'sha256:page-1',
        title: 'Kafka',
        text: 'Kafka backs async events.',
        references: [],
      },
    ],
    artifacts: [
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        artifactId: '11111111-1111-4111-8111-111111111111',
        title: 'Kafka usage',
        contentMarkdown: 'Kafka backs async events.',
        sourcePageIds: ['page-1'],
        compilerVersion: 'test-compiler',
        promptVersion: 'test-prompt',
        inputSourceRefs: [
          {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            contentHash: 'sha256:page-1',
          },
        ],
        chunks: [
          {
            text: 'Kafka backs async events.',
            inputSourceRefs: [
              {
                workspaceId: 'workspace-1',
                spaceId: 'space-1',
                sourcePageId: 'page-1',
                sourceVersion: 'v1',
                contentHash: 'sha256:page-1',
              },
            ],
          },
        ],
      },
    ],
  };
}
