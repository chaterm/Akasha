import { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { KnowledgeCapsuleRepo } from '@docmost/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeSourceRepo } from '@docmost/db/repos/llm-wiki/knowledge-source.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { QueueJob } from '../../../integrations/queue/constants';
import { KnowledgeCompilerAdapter } from '../adapters/knowledge-compiler.adapter';
import { KnowledgeAccessIndexerService } from '../services/knowledge-access-indexer.service';
import { KnowledgeImportService } from '../services/knowledge-import.service';
import { KnowledgeSourceExporterService } from '../services/knowledge-source-exporter.service';
import { LlmWikiProcessor } from './llm-wiki.processor';

describe('LlmWikiProcessor', () => {
  it('exports, compiles, imports, and reindexes access for knowledge compile jobs', async () => {
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
    const compiler = {
      compileSpace: jest.fn().mockResolvedValue({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sources: [],
        compilerVersion: 'docmost-internal-compiler',
        promptVersion: 'docmost-enterprise-kb-v1',
        compilerRunId: 'run-1',
        artifacts: [],
        diagnostics: { warnings: [], errors: [] },
      }),
    };
    const importer = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 2,
        quarantinedArtifactCount: 1,
      }),
    };
    const accessIndexer = createAccessIndexer();
    const processor = new LlmWikiProcessor(
      exporter as unknown as KnowledgeSourceExporterService,
      compiler as unknown as KnowledgeCompilerAdapter,
      importer as unknown as KnowledgeImportService,
      accessIndexer,
      createSourceRepo(),
      createCapsuleRepo(),
      createPageRepo(),
      createAiQueue(),
    );

    const result = await processor.process({
      name: QueueJob.KNOWLEDGE_COMPILE_SPACE,
      data: { workspaceId: 'workspace-1', spaceId: 'space-1' },
    } as Job);

    expect(exporter.exportSpaceSources).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(compiler.compileSpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: 'docmost-internal-compiler',
      promptVersion: 'docmost-enterprise-kb-v1',
      sources: [
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
      ],
    });
    expect(importer.importCompileResult).toHaveBeenCalledWith({
      input: compiler.compileSpace.mock.calls[0][0],
      artifacts: [],
    });
    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(result).toEqual({
      type: 'compile-space',
      status: 'succeeded',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerRunId: 'run-1',
      sourceCount: 1,
      importedArtifactCount: 2,
      quarantinedArtifactCount: 1,
      durationMs: expect.any(Number),
    });
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

  it('marks content-updated pages stale and enqueues delayed space compile jobs', async () => {
    const sourceRepo = createSourceRepo();
    const capsuleRepo = createCapsuleRepo();
    const accessIndexer = createAccessIndexer();
    const pageRepo = createPageRepo();
    const aiQueue = createAiQueue();
    jest
      .mocked(pageRepo.findSpaceIdsForPages)
      .mockResolvedValue(['space-1', 'space-2']);
    const processor = new LlmWikiProcessor(
      createExporter(),
      createCompiler(),
      createImporter(),
      accessIndexer,
      sourceRepo,
      capsuleRepo,
      pageRepo,
      aiQueue,
    );

    await processor.process({
      name: QueueJob.PAGE_CONTENT_UPDATED,
      data: { workspaceId: 'workspace-1', pageIds: ['page-1'] },
    } as Job);

    expect(sourceRepo.markSourcesStale).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(capsuleRepo.markCapsulesStaleBySourcePageIds).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(accessIndexer.reindexSourcePages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-1'],
    });
    expect(pageRepo.findSpaceIdsForPages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_SPACE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'page_update',
      },
      {
        delay: 5000,
        jobId: expect.stringMatching(
          /^knowledge-compile-space:workspace-1:space-1:/,
        ),
      },
    );
    expect(aiQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_SPACE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-2',
        trigger: 'page_update',
      },
      {
        delay: 5000,
        jobId: expect.stringMatching(
          /^knowledge-compile-space:workspace-1:space-2:/,
        ),
      },
    );
  });
});

function createExporter(): KnowledgeSourceExporterService {
  return {
    exportSpaceSources: jest.fn().mockResolvedValue([]),
  } as unknown as KnowledgeSourceExporterService;
}

function createCompiler(): KnowledgeCompilerAdapter {
  return {
    compileSpace: jest.fn().mockResolvedValue({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sources: [],
      compilerVersion: 'docmost-internal-compiler',
      promptVersion: 'docmost-enterprise-kb-v1',
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
  } as unknown as KnowledgeCapsuleRepo;
}

function createPageRepo(): PageRepo {
  return {
    findSpaceIdsForPages: jest.fn().mockResolvedValue([]),
  } as unknown as PageRepo;
}

function createAiQueue(): Queue & { add: jest.Mock } {
  return {
    add: jest.fn().mockResolvedValue(undefined),
  } as unknown as Queue & { add: jest.Mock };
}
