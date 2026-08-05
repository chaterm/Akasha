import {
  KnowledgeDiagnosticsService,
  buildWorkerCapacityEstimate,
  classifyRunPageError,
  classifyRunQueueState,
  sanitizeRunPageErrorDetail,
} from './knowledge-diagnostics.service';

describe('scalable Knowledge Run diagnostics', () => {
  it('marks BullMQ worker capacity as an estimate and keeps unsupported Redis unknown', () => {
    expect(
      buildWorkerCapacityEstimate(
        [{ name: 'knowledge-space-worker-1' }, { name: 'worker-2' }],
        10,
      ),
    ).toEqual({
      workerCount: 2,
      capacity: 20,
      exact: false,
      source: 'bullmq_client_list',
    });
    expect(
      buildWorkerCapacityEstimate(
        [{ name: 'GCP does not support client list' }],
        10,
      ),
    ).toEqual({
      workerCount: null,
      capacity: null,
      exact: false,
      source: 'unsupported',
    });
    expect(buildWorkerCapacityEstimate(undefined, 10)).toEqual({
      workerCount: null,
      capacity: null,
      exact: false,
      source: 'unavailable',
    });
  });

  it('distinguishes initialization and continuation waits from active work', () => {
    expect(
      classifyRunQueueState({
        status: 'queued',
        phase: 'text',
        initializedAt: null,
      }),
    ).toBe('waiting_initialization');
    expect(
      classifyRunQueueState({
        status: 'queued',
        phase: 'text',
        initializedAt: new Date(),
      }),
    ).toBe('text_continuation');
    expect(
      classifyRunQueueState({
        status: 'queued',
        phase: 'image_merge',
        initializedAt: new Date(),
      }),
    ).toBe('image_merge_continuation');
    expect(
      classifyRunQueueState({
        status: 'compiling',
        phase: 'text',
        initializedAt: new Date(),
      }),
    ).toBeNull();
  });

  it('separates budget timeouts from provider and publication failures', () => {
    expect(classifyRunPageError('page_timeout')).toBe('budget_timeout');
    expect(classifyRunPageError('provider_error')).toBe('provider');
    expect(classifyRunPageError('publication_failed')).toBe('publication');
    expect(classifyRunPageError('storage_unavailable')).toBe('infrastructure');
    expect(classifyRunPageError(null)).toBeNull();
  });

  it('removes control characters from authorized error details', () => {
    expect(sanitizeRunPageErrorDetail('provider\u0000error\u001f detail')).toBe(
      'provider error detail',
    );
  });

  it('reports configured worker options without treating CLIENT LIST as scheduling authority', async () => {
    const imageQueue = {
      getWorkers: jest
        .fn()
        .mockResolvedValue([{ name: 'GCP does not support client list' }]),
    };
    const spaceQueue = {
      getWorkers: jest.fn().mockResolvedValue([{ name: 'space-worker-1' }]),
    };
    const service = new KnowledgeDiagnosticsService(
      {} as never,
      imageQueue as never,
      spaceQueue as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.getWorkerDiagnostics()).resolves.toMatchObject({
      schedulingAuthority: 'postgresql',
      space: {
        workerCount: 1,
        capacity: 10,
        exact: false,
        lockDuration: 120_000,
        stalledInterval: 30_000,
        maxStalledCount: 2,
      },
      image: {
        workerCount: null,
        capacity: null,
        source: 'unsupported',
      },
    });
  });

  it('returns empty bounded pages without touching the database when no Space is authorized', async () => {
    const service = new KnowledgeDiagnosticsService(
      { selectFrom: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.listRunDiagnostics({
        workspaceId: 'workspace-1',
        spaceIds: [],
        enforceSpaceScope: true,
      }),
    ).resolves.toEqual({ items: [], total: 0, page: 1, limit: 50 });
    await expect(
      service.listRunPageDiagnostics({
        workspaceId: 'workspace-1',
        runId: 'run-1',
        allowedSpaceIds: [],
      }),
    ).resolves.toBeUndefined();
  });

  it('derives retryability from the latest durable RunPage', async () => {
    const latestAlias = { alias: 'latest' };
    const latestQuery: Record<string, jest.Mock> = {};
    for (const method of ['select', 'where', 'distinctOn', 'orderBy']) {
      latestQuery[method] = jest.fn(() => latestQuery);
    }
    latestQuery.as = jest.fn(() => latestAlias);

    const currentQuery: Record<string, jest.Mock> = {};
    for (const method of ['select', 'where']) {
      currentQuery[method] = jest.fn(() => currentQuery);
    }
    currentQuery.execute = jest
      .fn()
      .mockResolvedValue([{ sourcePageId: 'page-failed' }]);

    const db = {
      selectFrom: jest.fn((source: unknown) =>
        source === 'knowledgeSpaceCompileRunPages as runPage'
          ? latestQuery
          : currentQuery,
      ),
    };
    const service = new KnowledgeDiagnosticsService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.findRetryableFailedPageIds({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-failed', 'page-succeeded', 'page-failed'],
      }),
    ).resolves.toEqual(['page-failed']);

    expect(db.selectFrom).not.toHaveBeenCalledWith(
      'knowledgeCompilationAttempts',
    );
    expect(latestQuery.where).toHaveBeenCalledWith(
      'runPage.sourcePageId',
      'in',
      ['page-failed', 'page-succeeded'],
    );
    expect(latestQuery.distinctOn).toHaveBeenCalledWith('runPage.sourcePageId');
    expect(currentQuery.where).toHaveBeenCalledWith(
      'latest.status',
      '=',
      'failed',
    );
  });

  it('loads quality, quarantine, and retrieval only through independent diagnostics calls', async () => {
    const qualityService = {
      getReport: jest.fn().mockResolvedValue('quality'),
    };
    const quarantineRepo = {
      listDiagnosticsPage: jest.fn().mockResolvedValue('quarantine'),
    };
    const queryAuditRepo = {
      summarizeWorkspace: jest.fn().mockResolvedValue('retrieval'),
    };
    const service = new KnowledgeDiagnosticsService(
      {} as never,
      {} as never,
      {} as never,
      qualityService as never,
      quarantineRepo as never,
      queryAuditRepo as never,
    );

    await expect(
      service.getQualityDiagnostics({
        workspaceId: 'workspace-1',
        spaceIds: ['space-1'],
      }),
    ).resolves.toBe('quality');
    await expect(
      service.listQuarantineDiagnostics({
        workspaceId: 'workspace-1',
        spaceIds: ['space-1'],
        page: 2,
        limit: 20,
      }),
    ).resolves.toBe('quarantine');
    await expect(
      service.getRetrievalDiagnostics({ workspaceId: 'workspace-1' }),
    ).resolves.toBe('retrieval');

    expect(qualityService.getReport).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
    });
    expect(quarantineRepo.listDiagnosticsPage).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceIds: ['space-1'],
      page: 2,
      limit: 20,
    });
    expect(queryAuditRepo.summarizeWorkspace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      limit: 500,
    });
  });
});
