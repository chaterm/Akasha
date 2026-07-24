import { ForbiddenException } from '@nestjs/common';
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
    const aiQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = {
      log: jest.fn(),
    };
    const controller = createController({ aiQueue, auditService });

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

    expect(aiQueue.add).toHaveBeenCalledWith(
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
    expect(aiQueue.add).toHaveBeenCalledWith(
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
    const aiQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    const controller = createController({ aiQueue });

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

    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      { workspaceId: 'workspace-1', spaceId: 'space-1' },
      expect.objectContaining({
        jobId: expect.stringMatching(
          /^knowledge-reindex-access__workspace-1__space-1__/,
        ),
      }),
    );
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      { workspaceId: 'workspace-1', spaceId: 'space-1' },
      expect.objectContaining({
        jobId: expect.stringMatching(
          /^knowledge-mark-stale__workspace-1__space-1__/,
        ),
      }),
    );
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_SPACE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'rebuild_embeddings',
      },
      expect.objectContaining({
        jobId: expect.stringMatching(
          /^knowledge-compile-space__workspace-1__space-1__/,
        ),
      }),
    );
  });

  it('rejects admin space actions from workspace members', async () => {
    const aiQueue = {
      add: jest.fn(),
    };
    const controller = createController({ aiQueue });

    await expect(
      controller.runAdminSpaceAction(
        { action: 'reindex_access', spaceIds: ['space-1'] },
        user(),
        workspace(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(aiQueue.add).not.toHaveBeenCalled();
  });

  it('returns knowledge diagnostics for admins', async () => {
    const diagnosticsService = {
      getWorkspaceDiagnostics: jest.fn().mockResolvedValue({
        pages: [{ pageId: 'page-1', title: 'Kafka', knowledgeChunkCount: 2 }],
        jobs: [{ id: 'job-1', name: QueueJob.KNOWLEDGE_COMPILE_SPACE }],
        compileStatuses: [],
      }),
    };
    const controller = createController({ diagnosticsService });

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
      statuses: ['failed'],
      stages: ['generation'],
      limit: 20,
    });
  });

  it('retries only selected pages through durable per-Space runs', async () => {
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
      startSpaceRun: jest
        .fn()
        .mockResolvedValueOnce({ id: 'retry-run-1' })
        .mockResolvedValueOnce({ id: 'retry-run-2' }),
    };
    const controller = createController({
      pageRepo,
      sourceExporter,
      spaceCompilation,
    });

    await expect(
      controller.retryPages(
        { pageIds: ['page-1', 'page-2', 'page-1'] },
        adminUser(),
        workspace(),
      ),
    ).resolves.toEqual({
      queuedPageCount: 2,
      jobIds: [
        expect.stringContaining(
          'knowledge-compile-pages__workspace-1__space-1__page-1__retry-run-1',
        ),
        expect.stringContaining(
          'knowledge-compile-pages__workspace-1__space-2__page-2__retry-run-2',
        ),
      ],
    });

    expect(spaceCompilation.startSpaceRun).toHaveBeenNthCalledWith(1, {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'retry_compile',
      sources: [
        expect.objectContaining({
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
        }),
      ],
    });
    expect(spaceCompilation.startSpaceRun).toHaveBeenNthCalledWith(2, {
      workspaceId: 'workspace-1',
      spaceId: 'space-2',
      trigger: 'retry_compile',
      sources: [expect.objectContaining({ sourcePageId: 'page-2' })],
    });
  });

  it('rejects knowledge diagnostics from workspace members', async () => {
    const diagnosticsService = {
      getWorkspaceDiagnostics: jest.fn(),
    };
    const controller = createController({ diagnosticsService });

    await expect(
      controller.getDiagnostics({}, user(), workspace()),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(diagnosticsService.getWorkspaceDiagnostics).not.toHaveBeenCalled();
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
    aiQueue?: { add: jest.Mock };
    pageRepo?: Partial<PageRepo>;
    sourceExporter?: Partial<KnowledgeSourceExporterService>;
    spaceCompilation?: Partial<KnowledgeSpaceCompilationService>;
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
      ...overrides.aiQueue,
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
      ...overrides.spaceCompilation,
    } as unknown as KnowledgeSpaceCompilationService,
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
