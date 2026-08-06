import { KnowledgePageCompilationService } from './knowledge-page-compilation.service';

describe('KnowledgePageCompilationService contract', () => {
  it('exposes page operations without accepting a BullMQ Job', () => {
    expect(KnowledgePageCompilationService.prototype.compileTextPage).toEqual(
      expect.any(Function),
    );
    expect(KnowledgePageCompilationService.prototype.mergePageImages).toEqual(
      expect.any(Function),
    );
    expect(
      KnowledgePageCompilationService.prototype.compileTextPage.length,
    ).toBe(2);
    expect(
      KnowledgePageCompilationService.prototype.mergePageImages.length,
    ).toBe(2);
  });

  it('publishes image merge results through a lease-bound execution context', async () => {
    const execution = {
      isActive: jest.fn().mockResolvedValue(false),
      completePage: jest.fn(),
      catalog: jest.fn(),
      publicationGuard: jest.fn(),
      publicationComplete: jest.fn(),
    };
    const service = Object.create(
      KnowledgePageCompilationService.prototype,
    ) as KnowledgePageCompilationService;

    await expect(
      service.mergePageImages(
        {
          data: {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            sourceContentHash: 'sha256:page-1',
            effectiveKnowledgeHash: 'pending',
            spaceRunId: 'run-1',
            knowledgeGeneration: 1,
            images: [],
          },
          compileTaskId: 'merge-1',
          finalAttempt: false,
          execution,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual(expect.objectContaining({ outcome: 'noop' }));
    expect(execution.isActive).toHaveBeenCalled();
  });

  it('retries a staged page import without invoking the compiler again', async () => {
    const source = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      contentHash: 'sha256:page-1',
      title: 'Page one',
      text: 'Page body',
      references: [],
      images: [],
    };
    const artifact = {
      artifactId: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      title: 'Page one',
      contentMarkdown: '# Page one',
      sourcePageIds: ['page-1'],
      artifactKind: 'source_summary',
      canonicalKey: 'page:page-1',
      compilerVersion: 'semantic@1',
      promptVersion: 'semantic@1',
      compilerRunId: 'original-compiler-run',
      compileTaskId: 'original-task',
      chunks: [{ text: 'Page body' }],
    };
    const pendingImport = {
      acceptedArtifacts: [artifact],
      quarantineInputs: [],
      quarantinedArtifactCount: 0,
    };
    const compiler = { compileSpace: jest.fn() };
    const importService = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    };
    const compilationRepo = {
      startAttempt: jest.fn(),
      updateSourceSnapshot: jest.fn(),
      findPendingImport: jest.fn().mockResolvedValue(pendingImport),
      updateStage: jest.fn(),
      savePendingImport: jest.fn(),
      succeedAttempt: jest.fn(),
      failAttempt: jest.fn(),
      skipAttempt: jest.fn(),
    };
    const accessIndexer = { reindexSourcePages: jest.fn() };
    const service = new KnowledgePageCompilationService(
      {
        exportPageSources: jest.fn().mockResolvedValue([source]),
      } as never,
      compiler as never,
      importService as never,
      accessIndexer as never,
      compilationRepo as never,
      { readReadySource: jest.fn() } as never,
    );
    const execution = {
      isActive: jest.fn().mockResolvedValue(true),
      markRunning: jest.fn(),
      completePage: jest.fn(),
      catalog: jest.fn(),
      publicationGuard: jest.fn(),
    };

    await expect(
      service.compileTextPage(
        {
          data: {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageIds: ['page-1'],
            sourceVersion: 'v1',
            sourceContentHash: 'sha256:page-1',
            spaceRunId: 'retry-run',
            knowledgeGeneration: 1,
          },
          compileTaskId: 'retry-task',
          finalAttempt: true,
          execution,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outcome: 'succeeded',
      result: { compilerRunId: 'original-compiler-run' },
    });

    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(execution.catalog).not.toHaveBeenCalled();
    expect(importService.importCompileResult).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedImport: pendingImport,
        artifacts: pendingImport.acceptedArtifacts,
      }),
    );
    expect(compilationRepo.succeedAttempt).toHaveBeenCalled();
    expect(execution.completePage).toHaveBeenCalledWith({
      status: 'succeeded',
    });
  });
});
