import { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeReviewApplicationRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-application.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { QueueJob } from '../../../integrations/queue/constants';
import { KnowledgeCompilerAdapter } from '../adapters/knowledge-compiler.adapter';
import { KnowledgeAccessIndexerService } from '../services/knowledge-access-indexer.service';
import { KnowledgeArtifactCatalogService } from '../services/knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from '../services/knowledge-space-compilation.service';
import { KnowledgeSpaceAggregatorService } from '../services/knowledge-space-aggregator.service';
import { KnowledgeImportService } from '../services/knowledge-import.service';
import { KnowledgeSourceExporterService } from '../services/knowledge-source-exporter.service';
import { IAuditService } from '../../../integrations/audit/audit.service';
import { ReviewService } from '../review/review.service';
import { ReviewSnapshotService } from '../review/review-snapshot.service';
import { LlmWikiProcessor } from './llm-wiki.processor';

describe('LlmWikiProcessor', () => {
  it('creates a durable Space run instead of reporting fan-out as complete', async () => {
    const exporter = {
      exportSpaceSources: jest.fn().mockResolvedValue([
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v1',
          contentHash: 'sha256:page-1',
          title: 'Page',
          text: 'Body',
          references: [],
        },
      ]),
    };
    const compiler = createCompiler();
    const importer = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 2,
        quarantinedArtifactCount: 1,
      }),
    };
    const accessIndexer = createAccessIndexer();
    const aiQueue = createAiQueue();
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      startSpaceRun: jest.fn().mockResolvedValue({ id: 'space-run-1' }),
    };
    const processor = new LlmWikiProcessor(
      exporter as unknown as KnowledgeSourceExporterService,
      compiler as unknown as KnowledgeCompilerAdapter,
      importer as unknown as KnowledgeImportService,
      accessIndexer,
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      aiQueue,
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      compilationRepo as never,
      undefined,
      spaceCompilation as unknown as KnowledgeSpaceCompilationService,
    );

    const result = await processor.process({
      name: QueueJob.KNOWLEDGE_COMPILE_SPACE,
      data: { workspaceId: 'workspace-1', spaceId: 'space-1' },
    } as Job);

    expect(exporter.exportSpaceSources).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(spaceCompilation.startSpaceRun).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      sources: [
        expect.objectContaining({
          sourcePageId: 'page-1',
        }),
      ],
    });
    expect(aiQueue.add).not.toHaveBeenCalled();
    expect(compilationRepo.queueAttempt).not.toHaveBeenCalled();
    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(accessIndexer.reindexSourcePages).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        type: 'compile-space',
        status: 'queued',
        compilerRunId: 'space-run-1',
        sourceCount: 1,
      }),
    );
  });

  it('exports and replaces only requested sources for page compile jobs', async () => {
    const sources = [
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        sourceVersion: 'v2',
        contentHash: 'sha256:page-1-v2',
        title: 'Changed page',
        text: 'Changed body',
        references: [],
      },
    ];
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue(sources),
    };
    const compiler = createCompiler();
    const importer = createImporter();
    const accessIndexer = createAccessIndexer();
    const processor = new LlmWikiProcessor(
      exporter as unknown as KnowledgeSourceExporterService,
      compiler,
      importer,
      accessIndexer,
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createAiQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
    );

    const result = await processor.process({
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      },
    } as Job);

    expect(exporter.exportPageSources).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });
    expect(compiler.compileSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        compileMode: 'pages',
        sources,
      }),
    );
    expect(importer.importCompileResult).toHaveBeenCalledWith({
      input: jest.mocked(compiler.compileSpace).mock.calls[0][0],
      artifacts: [],
      onStage: expect.any(Function),
    });
    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(result).toEqual(
      expect.objectContaining({
        type: 'compile-pages',
        sourceCount: 1,
      }),
    );
  });

  it('passes the active Space artifact catalog into page compilation', async () => {
    const source = sourceSnapshot();
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const catalogService = {
      snapshot: jest.fn().mockResolvedValue({
        entries: [
          {
            artifactId: '22222222-2222-4222-8222-222222222222',
            artifactKind: 'concept',
            canonicalKey: 'event-sourcing',
            title: 'Event sourcing',
            summary: 'Append-only changes.',
          },
        ],
        hash: 'sha256:catalog',
      }),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      catalogService,
    });

    await processor.process({
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      },
    } as Job);

    expect(catalogService.snapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(jest.mocked(compiler.compileSpace).mock.calls[0][0].catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalKey: 'event-sourcing' }),
      ]),
    );
  });

  it('uses the immutable run catalog for a Space fan-out page job', async () => {
    const source = sourceSnapshot();
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const catalogService = { snapshot: jest.fn() };
    const runEntries = [
      {
        artifactId: '33333333-3333-4333-8333-333333333333',
        artifactKind: 'concept',
        canonicalKey: 'snapshot-concept',
        title: 'Snapshot concept',
        summary: 'Frozen at run creation.',
      },
    ];
    const spaceCompilation = {
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn().mockResolvedValue(runEntries),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      catalogService,
      spaceCompilation,
    });

    await processor.process({
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        spaceRunId: 'space-run-1',
      },
    } as Job);

    expect(spaceCompilation.catalogForPage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(catalogService.snapshot).not.toHaveBeenCalled();
    expect(jest.mocked(compiler.compileSpace).mock.calls[0][0].catalog).toEqual(
      runEntries,
    );
  });

  it('skips a Space run page whose source changed after the run snapshot', async () => {
    const source = sourceSnapshot({
      sourceVersion: 'v2',
      contentHash: 'hash-2',
    });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn(),
    };
    const processor = createProcessor({
      exporter,
      compiler,
      compilationRepo,
      spaceCompilation,
    });

    const result = await processor.process({
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        sourceVersion: 'v1',
        sourceContentHash: 'hash-1',
        spaceRunId: 'space-run-1',
      },
    } as Job);

    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(spaceCompilation.catalogForPage).not.toHaveBeenCalled();
    expect(compilationRepo.failAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      errorCode: 'source_changed',
      errorMessage: 'Knowledge source changed after the Space run snapshot.',
    });
    expect(spaceCompilation.completePage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
      status: 'skipped',
      errorCode: 'source_changed',
      errorMessage: 'Knowledge source changed after the Space run snapshot.',
    });
    expect(result).toEqual(
      expect.objectContaining({ status: 'succeeded', sourceCount: 0 }),
    );
  });

  it('rejects page compile batches so one failed page cannot fail its peers', async () => {
    const exporter = createExporter();
    const processor = createProcessor({ exporter });

    await expect(
      processor.process({
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1', 'page-2'],
        },
      } as Job),
    ).rejects.toThrow('exactly one source page');

    expect(exporter.exportPageSources).not.toHaveBeenCalled();
  });

  it('records page attempt stages and succeeds only after atomic import', async () => {
    const source = sourceSnapshot({ sourceVersion: 'v2' });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compilationRepo = createCompilationRepo();
    const importer = createImporter();
    jest
      .mocked(importer.importCompileResult)
      .mockImplementation(async (input) => {
        await input.onStage?.('validation');
        await input.onStage?.('merge');
        await input.onStage?.('import');
        return { importedArtifactCount: 0, quarantinedArtifactCount: 0 };
      });
    const processor = createProcessor({
      exporter,
      importer,
      compilationRepo,
    });

    await processor.process({
      id: 'page-job-1',
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
      },
    } as Job);

    expect(compilationRepo.startAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-1',
        compileTaskId: 'page-job-1',
      }),
    );
    expect(compilationRepo.updateSourceSnapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v2',
      sourceContentHash: source.contentHash,
    });
    expect(compilationRepo.updateStage).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      stage: 'validation',
    });
    expect(compilationRepo.updateStage.mock.calls.slice(-3)).toEqual([
      [
        {
          workspaceId: 'workspace-1',
          sourcePageId: 'page-1',
          stage: 'validation',
        },
      ],
      [
        {
          workspaceId: 'workspace-1',
          sourcePageId: 'page-1',
          stage: 'merge',
        },
      ],
      [
        {
          workspaceId: 'workspace-1',
          sourcePageId: 'page-1',
          stage: 'import',
        },
      ],
    ]);
    expect(compilationRepo.succeedAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v2',
      sourceContentHash: source.contentHash,
    });
  });

  it('advances a durable Space run page through running and succeeded', async () => {
    const source = sourceSnapshot();
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const spaceCompilation = {
      markPageRunning: jest.fn().mockResolvedValue(undefined),
      completePage: jest.fn().mockResolvedValue(undefined),
      catalogForPage: jest.fn().mockResolvedValue([]),
    };
    const processor = createProcessor({ exporter, spaceCompilation });

    await processor.process({
      id: 'page-job-1',
      name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        spaceRunId: 'space-run-1',
      },
    } as Job);

    expect(spaceCompilation.markPageRunning).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
    });
    expect(spaceCompilation.completePage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
      status: 'succeeded',
    });
  });

  it('runs the durable Space aggregation job after the page barrier opens', async () => {
    const spaceAggregator = {
      aggregate: jest.fn().mockResolvedValue({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    };
    const processor = createProcessor({ spaceAggregator });

    const result = await processor.process({
      id: 'knowledge-aggregate-space__space-run-1',
      name: QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        spaceRunId: 'space-run-1',
      },
    } as Job);

    expect(spaceAggregator.aggregate).toHaveBeenCalledWith({
      runId: 'space-run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(result).toEqual(
      expect.objectContaining({
        type: 'compile-space',
        status: 'succeeded',
        compilerRunId: 'space-run-1',
        importedArtifactCount: 1,
      }),
    );
  });

  it('records export failures after starting the queued page attempt', async () => {
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest
        .fn()
        .mockRejectedValue(new Error('source storage unavailable')),
    };
    const compilationRepo = createCompilationRepo();
    const processor = createProcessor({ exporter, compilationRepo });

    await expect(
      processor.process({
        id: 'page-job-1',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).rejects.toThrow('source storage unavailable');

    expect(compilationRepo.startAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        compileTaskId: 'page-job-1',
      }),
    );
    expect(compilationRepo.failAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      errorCode: 'compile_failed',
      errorMessage: 'Knowledge compilation failed.',
    });
  });

  it('finishes a Space run page when its source is no longer available', async () => {
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([]),
    };
    const compilationRepo = createCompilationRepo();
    const spaceCompilation = {
      markPageRunning: jest.fn(),
      completePage: jest.fn(),
      catalogForPage: jest.fn(),
    };
    const processor = createProcessor({
      exporter,
      compilationRepo,
      spaceCompilation,
    });

    await expect(
      processor.process({
        id: 'page-job-missing',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
          spaceRunId: 'space-run-1',
        },
        opts: { attempts: 3 },
        attemptsMade: 0,
      } as Job),
    ).rejects.toThrow('Knowledge source page is unavailable for compilation.');

    expect(compilationRepo.failAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      errorCode: 'source_unavailable',
      errorMessage: 'Knowledge source page is unavailable for compilation.',
    });
    expect(spaceCompilation.completePage).toHaveBeenCalledWith({
      runId: 'space-run-1',
      sourcePageId: 'page-1',
      status: 'failed',
      errorCode: 'source_unavailable',
      errorMessage: 'Knowledge source page is unavailable for compilation.',
    });
  });

  it('records an empty source as non-retryable without invoking the compiler', async () => {
    const source = sourceSnapshot({ text: '   ' });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest.fn().mockResolvedValue([source]),
    };
    const compiler = createCompiler();
    const compilationRepo = createCompilationRepo();
    const processor = createProcessor({
      exporter,
      compiler,
      compilationRepo,
    });

    await expect(
      processor.process({
        id: 'page-job-empty',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).rejects.toThrow('Knowledge source page is empty.');

    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(compilationRepo.failAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      errorCode: 'empty_source',
      errorMessage: 'Knowledge source page is empty.',
    });
  });

  it('discards a compile result when the source changes before import', async () => {
    const before = sourceSnapshot({
      sourceVersion: 'v1',
      contentHash: 'sha256:v1',
    });
    const after = sourceSnapshot({
      sourceVersion: 'v2',
      contentHash: 'sha256:v2',
    });
    const exporter = {
      exportSpaceSources: jest.fn(),
      exportPageSources: jest
        .fn()
        .mockResolvedValueOnce([before])
        .mockResolvedValueOnce([after]),
    };
    const importer = createImporter();
    const compilationRepo = createCompilationRepo();
    const processor = createProcessor({
      exporter,
      importer,
      compilationRepo,
    });

    await expect(
      processor.process({
        id: 'page-job-1',
        name: QueueJob.KNOWLEDGE_COMPILE_PAGES,
        data: {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageIds: ['page-1'],
        },
      } as Job),
    ).rejects.toThrow('changed during compilation');

    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(compilationRepo.failAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'source_changed' }),
    );
    expect(compilationRepo.succeedAttempt).not.toHaveBeenCalled();
  });

  it('ignores unrelated jobs on the shared AI queue', async () => {
    const exporter = {
      exportSpaceSources: jest.fn(),
    };
    const processor = new LlmWikiProcessor(
      exporter as unknown as KnowledgeSourceExporterService,
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createAiQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
    );

    await processor.process({ name: QueueJob.PAGE_CREATED, data: {} } as Job);

    expect(exporter.exportSpaceSources).not.toHaveBeenCalled();
  });

  it('reindexes exact source access when source page ids are provided', async () => {
    const accessIndexer = createAccessIndexer();
    const processor = new LlmWikiProcessor(
      createExporter(),
      createCompiler(),
      createImporter(),
      accessIndexer,
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createAiQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
    );

    await processor.process({
      name: QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      data: {
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1', 'page-2'],
      },
    } as Job);

    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
    expect(accessIndexer.markScopeStale).not.toHaveBeenCalled();
  });

  it('reindexes all known source access when a space id is provided', async () => {
    const accessIndexer = createAccessIndexer();
    const sourceRepo = createSourceRepo();
    jest
      .mocked(sourceRepo.findSourcesBySpace)
      .mockResolvedValue([
        { sourcePageId: 'page-1' },
        { sourcePageId: 'page-2' },
        { sourcePageId: 'page-1' },
      ] as never);
    const processor = new LlmWikiProcessor(
      createExporter(),
      createCompiler(),
      createImporter(),
      accessIndexer,
      sourceRepo,
      createCapsuleRepo(),
      createPageRepo(),
      createAiQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
    );

    await processor.process({
      name: QueueJob.KNOWLEDGE_REINDEX_ACCESS,
      data: { workspaceId: 'workspace-1', spaceId: 'space-1' },
    } as Job);

    expect(sourceRepo.findSourcesBySpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
    expect(accessIndexer.markScopeStale).not.toHaveBeenCalled();
  });

  it('marks sources and dependent capsules stale for source invalidation jobs', async () => {
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    const processor = new LlmWikiProcessor(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      sourceRepo,
      capsuleRepo,
      createPageRepo(),
      createAiQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
    );

    await processor.process({
      name: QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      data: { workspaceId: 'workspace-1', sourcePageIds: ['page-1'] },
    } as Job);

    expect(sourceRepo.markSourcesStale).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(capsuleRepo.markCapsulesStaleBySourcePageIds).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
  });

  it('marks all known sources in a space stale for admin space invalidation jobs', async () => {
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    jest
      .mocked(sourceRepo.findSourcesBySpace)
      .mockResolvedValue([
        { sourcePageId: 'page-1' },
        { sourcePageId: 'page-2' },
        { sourcePageId: 'page-1' },
      ] as never);
    const processor = new LlmWikiProcessor(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      sourceRepo,
      capsuleRepo,
      createPageRepo(),
      createAiQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
    );

    await processor.process({
      name: QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      data: { workspaceId: 'workspace-1', spaceId: 'space-1' },
    } as Job);

    expect(sourceRepo.findSourcesBySpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(sourceRepo.markSourcesStale).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
    expect(capsuleRepo.markCapsulesStaleBySourcePageIds).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
  });

  it('can invalidate only page-owned source artifacts', async () => {
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    const processor = new LlmWikiProcessor(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      sourceRepo,
      capsuleRepo,
      createPageRepo(),
      createAiQueue(),
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
    );

    await processor.process({
      name: QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
      data: {
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
        mode: 'source_artifacts',
      },
    } as Job);

    expect(
      capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(capsuleRepo.markCapsulesStaleBySourcePageIds).not.toHaveBeenCalled();
  });

  it('runs review discover jobs and stores the discovered snapshot', async () => {
    const item = {
      id: 'rev-1',
      type: 'suggestion',
      title: 'Improve launch notes',
      detail: 'Missing operational notes.',
      recommendation: 'Add operational readiness context.',
      relatedDocIds: ['kp-1'],
      searchQueries: [],
      targetDocId: 'kp-1',
    };
    const reviewService = createReviewService();
    jest
      .mocked(reviewService.reviewWiki)
      .mockResolvedValue({ version: '2', items: [item] } as never);
    const snapshotService = createReviewSnapshotService();
    const auditService = createAuditService();
    const capsuleRepo = createCapsuleRepoWithReviewPages();
    const processor = new LlmWikiProcessor(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      createSourceRepo(),
      capsuleRepo,
      createPageRepo(),
      createAiQueue(),
      reviewService,
      snapshotService,
      auditService,
      createReviewApplicationRepo(),
    );

    await processor.process({
      id: 'review-discover__workspace-1__space-1',
      name: QueueJob.REVIEW_DISCOVER,
      data: { workspaceId: 'workspace-1', spaceId: 'space-1', limit: 20 },
    } as Job);

    expect(snapshotService.markJobRunning).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      jobId: 'review-discover__workspace-1__space-1',
    });
    expect(reviewService.reviewWiki).toHaveBeenCalled();
    expect(snapshotService.replaceDiscoveredSnapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      items: [item],
      docs: [{ id: 'kp-1', title: 'Launch plan', sourcePageId: 'page-1' }],
    });
    expect(snapshotService.markJobDone).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      jobId: 'review-discover__workspace-1__space-1',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'knowledge.review_discovered',
        metadata: expect.objectContaining({
          limit: 20,
          documentCount: 1,
          reviewItemCount: 1,
        }),
      }),
    );
  });

  it('runs review negotiate jobs with authoritative prior history from the snapshot', async () => {
    const item = {
      id: 'rev-2',
      type: 'suggestion',
      title: 'Improve rollback section',
      detail: 'Rollback section needs refinement.',
      recommendation: 'Refine rollback wording.',
      relatedDocIds: ['kp-1'],
      searchQueries: [],
      targetDocId: 'kp-1',
    };
    const priorDraft = {
      title: 'Rollback criteria',
      body: '## Rollback criteria\n\nRollback when error budget burns fast.',
      applyOperation: ['append-section'] as ['append-section'],
      targetDocId: 'kp-1',
      notes: '',
    };
    const nextDraft = {
      ...priorDraft,
      body: '## Rollback criteria\n\nRollback when user-visible errors rise.',
      notes: 'Tightened the trigger.',
    };
    const priorTurn = {
      feedback: '采纳',
      draft: priorDraft,
      deepSearched: false,
      searchResults: [],
    };
    const reviewService = createReviewService();
    jest.mocked(reviewService.negotiateDraft).mockResolvedValue(nextDraft);
    const snapshotService = createReviewSnapshotService();
    jest.mocked(snapshotService.loadSnapshot).mockResolvedValue({
      version: '2',
      items: [item],
      docs: [],
      resolvedReviews: [
        {
          item,
          feedback: '采纳',
          skipped: false,
          deepSearched: false,
          searchResults: [],
          draft: priorDraft,
          applied: null,
          turns: [priorTurn],
        },
      ],
      jobs: [],
      applications: [],
      discoveredAt: '2026-06-22T03:00:00.000Z',
      updatedAt: '2026-06-22T03:10:00.000Z',
    } as never);
    const processor = new LlmWikiProcessor(
      createExporter(),
      createCompiler(),
      createImporter(),
      createAccessIndexer(),
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createAiQueue(),
      reviewService,
      snapshotService,
      createAuditService(),
      createReviewApplicationRepo(),
    );

    await processor.process({
      id: 'review-negotiate__workspace-1__space-1__rev-2',
      name: QueueJob.REVIEW_NEGOTIATE,
      data: {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        item,
        feedback: '把触发条件改得更准确',
      },
    } as Job);

    expect(reviewService.negotiateDraft).toHaveBeenCalledWith(
      expect.anything(),
      item,
      '把触发条件改得更准确',
      [],
      [priorTurn],
    );
    expect(snapshotService.saveResolvedReview).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      resolved: expect.objectContaining({
        item,
        feedback: '把触发条件改得更准确',
        draft: nextDraft,
        turns: [
          priorTurn,
          expect.objectContaining({
            feedback: '把触发条件改得更准确',
            draft: nextDraft,
          }),
        ],
      }),
    });
  });

  it('keeps content-updated pages available and enqueues isolated retryable jobs', async () => {
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    const accessIndexer = createAccessIndexer();
    const pageRepo = createPageRepo();
    const aiQueue = createAiQueue();
    const compilationRepo = createCompilationRepo();
    jest.mocked(pageRepo.findExistingPageRefs).mockResolvedValue([
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
    ]);
    const processor = new LlmWikiProcessor(
      createExporter(),
      createCompiler(),
      createImporter(),
      accessIndexer,
      sourceRepo,
      capsuleRepo,
      pageRepo,
      aiQueue,
      createReviewService(),
      createReviewSnapshotService(),
      createAuditService(),
      createReviewApplicationRepo(),
      compilationRepo as never,
    );

    await processor.process({
      name: QueueJob.PAGE_CONTENT_UPDATED,
      data: { workspaceId: 'workspace-1', pageIds: ['page-1', 'page-2'] },
    } as Job);

    expect(sourceRepo.markSourcesStale).not.toHaveBeenCalled();
    expect(
      capsuleRepo.markSourceArtifactsStaleBySourcePageIds,
    ).not.toHaveBeenCalled();
    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1', 'page-2'],
    });
    expect(pageRepo.findExistingPageRefs).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      pageIds: ['page-1', 'page-2'],
    });
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        trigger: 'page_update',
      },
      {
        delay: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        jobId: expect.stringMatching(
          /^knowledge-compile-pages__workspace-1__space-1__page-1__/,
        ),
      },
    );
    expect(compilationRepo.queueAttempt).toHaveBeenCalledTimes(2);
    expect(compilationRepo.queueAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        sourceVersion: undefined,
        sourceContentHash: undefined,
      }),
    );
    expect(
      compilationRepo.queueAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan(aiQueue.add.mock.invocationCallOrder[1]);
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-2',
        sourcePageIds: ['page-2'],
        trigger: 'page_update',
      },
      {
        delay: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        jobId: expect.stringMatching(
          /^knowledge-compile-pages__workspace-1__space-2__page-2__/,
        ),
      },
    );
  });
});

function createExporter(): KnowledgeSourceExporterService {
  return {
    exportSpaceSources: jest.fn().mockResolvedValue([]),
    exportPageSources: jest.fn().mockResolvedValue([]),
  } as unknown as KnowledgeSourceExporterService;
}

function createProcessor(
  overrides: {
    exporter?: unknown;
    compiler?: KnowledgeCompilerAdapter;
    catalogService?: Partial<KnowledgeArtifactCatalogService>;
    spaceCompilation?: Partial<KnowledgeSpaceCompilationService>;
    spaceAggregator?: Partial<KnowledgeSpaceAggregatorService>;
    importer?: KnowledgeImportService;
    compilationRepo?: ReturnType<typeof createCompilationRepo>;
  } = {},
): LlmWikiProcessor {
  return new LlmWikiProcessor(
    (overrides.exporter ?? createExporter()) as KnowledgeSourceExporterService,
    overrides.compiler ?? createCompiler(),
    overrides.importer ?? createImporter(),
    createAccessIndexer(),
    createSourceRepo(),
    createCapsuleRepo(),
    createPageRepo(),
    createAiQueue(),
    createReviewService(),
    createReviewSnapshotService(),
    createAuditService(),
    createReviewApplicationRepo(),
    overrides.compilationRepo as never,
    overrides.catalogService as KnowledgeArtifactCatalogService,
    overrides.spaceCompilation as KnowledgeSpaceCompilationService,
    overrides.spaceAggregator as KnowledgeSpaceAggregatorService,
  );
}

function createCompilationRepo() {
  return {
    queueAttempt: jest.fn().mockResolvedValue(undefined),
    startAttempt: jest.fn().mockResolvedValue(undefined),
    updateSourceSnapshot: jest.fn().mockResolvedValue(undefined),
    updateStage: jest.fn().mockResolvedValue(undefined),
    failAttempt: jest.fn().mockResolvedValue(undefined),
    succeedAttempt: jest.fn().mockResolvedValue(undefined),
  };
}

function sourceSnapshot(
  overrides: Partial<{
    sourceVersion: string;
    contentHash: string;
    text: string;
  }> = {},
) {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'sha256:v1',
    title: 'Page',
    text: 'Body',
    references: [],
    ...overrides,
  };
}

function createCompiler(): KnowledgeCompilerAdapter {
  return {
    compileSpace: jest.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sources: [],
      compilerVersion: 'akasha-internal-compiler',
      promptVersion: 'akasha-enterprise-kb-v1',
      compilerRunId: 'run-1',
      artifacts: [],
      diagnostics: { warnings: [], errors: [] },
    }),
  };
}

function createImporter(): KnowledgeImportService {
  return {
    importCompileResult: jest.fn().mockResolvedValue({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
    }),
  } as unknown as KnowledgeImportService;
}

function createAccessIndexer(): KnowledgeAccessIndexerService {
  return {
    reindexSourcePages: jest.fn().mockResolvedValue({ indexedCount: 0 }),
    markScopeStale: jest.fn().mockResolvedValue(undefined),
  } as unknown as KnowledgeAccessIndexerService;
}

function createSourceRepo(): KnowledgeSourceRepo {
  return {
    markSourcesStale: jest.fn().mockResolvedValue(undefined),
    findSourcesBySpace: jest.fn().mockResolvedValue([]),
  } as unknown as KnowledgeSourceRepo;
}

function createCapsuleRepo(): KnowledgeCapsuleRepo {
  return {
    markCapsulesStaleBySourcePageIds: jest.fn().mockResolvedValue(undefined),
    markSourceArtifactsStaleBySourcePageIds: jest
      .fn()
      .mockResolvedValue(undefined),
  } as unknown as KnowledgeCapsuleRepo;
}

function createCapsuleRepoWithReviewPages(): KnowledgeCapsuleRepo {
  return {
    ...createCapsuleRepo(),
    findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
      pages: [
        {
          id: 'kp-1',
          title: 'Launch plan',
          body: 'Launch body',
          folderId: null,
          pageType: 'source_summary',
          tags: [],
          status: 'reviewed',
          confidence: 0.8,
        },
      ],
      pageSources: [{ knowledgePageId: 'kp-1', sourcePageId: 'page-1' }],
      links: [],
      linkSources: [],
      graphEdges: [],
      graphEdgeSources: [],
    }),
    findClaimsByPageIds: jest.fn().mockResolvedValue([]),
  } as unknown as KnowledgeCapsuleRepo;
}

function createPageRepo(): PageRepo {
  return {
    findSpaceIdsForPages: jest.fn().mockResolvedValue([]),
    findExistingPageRefs: jest.fn().mockResolvedValue([]),
  } as unknown as PageRepo;
}

function createAiQueue(): Queue & { add: jest.Mock } {
  return {
    add: jest.fn().mockResolvedValue(undefined),
  } as unknown as Queue & { add: jest.Mock };
}

function createReviewService(): ReviewService {
  return {
    reviewWiki: jest.fn().mockResolvedValue({ version: '2', items: [] }),
    runDeepSearch: jest.fn().mockResolvedValue([]),
    negotiateDraft: jest.fn(),
  } as unknown as ReviewService;
}

function createReviewSnapshotService(): ReviewSnapshotService {
  return {
    beginJob: jest.fn().mockResolvedValue({
      job: {
        jobId: 'job-1',
        kind: 'discover',
        itemId: null,
        status: 'pending',
        error: null,
        createdAt: '2026-06-25T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
      },
      isNew: false,
    }),
    markJobRunning: jest.fn().mockResolvedValue(undefined),
    markJobDone: jest.fn().mockResolvedValue(undefined),
    markJobFailed: jest.fn().mockResolvedValue(undefined),
    replaceDiscoveredSnapshot: jest.fn().mockResolvedValue(undefined),
    loadSnapshot: jest.fn().mockResolvedValue(null),
    saveResolvedReview: jest.fn().mockResolvedValue(undefined),
  } as unknown as ReviewSnapshotService;
}

function createAuditService(): IAuditService {
  return {
    log: jest.fn(),
  } as unknown as IAuditService;
}

function createReviewApplicationRepo(): KnowledgeReviewApplicationRepo {
  return {
    supersedeDraftsForReviewItem: jest.fn().mockResolvedValue(0),
  } as unknown as KnowledgeReviewApplicationRepo;
}
