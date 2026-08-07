import { Logger } from '@nestjs/common';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
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

  it('recomputes generation and schedules self-healing for degraded output', async () => {
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
    const compiler = {
      compileSpace: jest.fn().mockResolvedValue({
        artifacts: [artifact],
        compilerRunId: 'fresh-compiler-run',
        resultQuality: 'degraded',
        generationAttemptCount: 1,
      }),
    };
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
    const runRepo = { requestRuns: jest.fn().mockResolvedValue([]) };
    const service = new KnowledgePageCompilationService(
      {
        exportPageSources: jest.fn().mockResolvedValue([source]),
      } as never,
      compiler as never,
      importService as never,
      accessIndexer as never,
      compilationRepo as never,
      { readReadySource: jest.fn() } as never,
      runRepo as never,
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
      result: { compilerRunId: 'fresh-compiler-run' },
    });

    expect(compilationRepo.findPendingImport).not.toHaveBeenCalled();
    expect(compiler.compileSpace).toHaveBeenCalled();
    expect(execution.catalog).toHaveBeenCalled();
    expect(importService.importCompileResult).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [artifact],
      }),
    );
    expect(
      importService.importCompileResult.mock.calls[0][0],
    ).not.toHaveProperty('preparedImport');
    expect(compilationRepo.succeedAttempt).toHaveBeenCalled();
    expect(execution.completePage).toHaveBeenCalledWith({
      status: 'succeeded',
      qualityStatus: 'degraded',
    });
    expect(runRepo.requestRuns).toHaveBeenCalledWith({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          trigger: 'page_retry',
          targetSourcePageIds: ['page-1'],
        },
      ],
      compilerVersion: expect.any(String),
      promptVersion: expect.any(String),
    });
  });

  it('logs provider diagnostics when compiler failures carry diagnostic metadata', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const compilerError = new KnowledgeCompilerLlmError(
      'input_too_large',
      'Knowledge compiler input exceeds the provider context limit.',
      false,
      undefined,
      {
        stage: 'generation',
        statusCode: 413,
        providerCode: 'context_length_exceeded',
        requestId: 'req-1',
      },
    );
    const compilationRepo = {
      startAttempt: jest.fn(),
      updateSourceSnapshot: jest.fn(),
      updateStage: jest.fn(),
      failAttempt: jest.fn(),
      skipAttempt: jest.fn(),
    };
    const execution = {
      isActive: jest.fn().mockResolvedValue(true),
      markRunning: jest.fn(),
      completePage: jest.fn(),
      catalog: jest.fn().mockResolvedValue([]),
      publicationGuard: jest.fn(),
    };
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
    const service = new KnowledgePageCompilationService(
      {
        exportPageSources: jest.fn().mockResolvedValue([source]),
      } as never,
      { compileSpace: jest.fn().mockRejectedValue(compilerError) } as never,
      {} as never,
      {} as never,
      compilationRepo as never,
      { readReadySource: jest.fn() } as never,
    );

    await expect(
      service.compileTextPage(
        {
          data: {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageIds: ['page-1'],
            sourceVersion: 'v1',
            sourceContentHash: 'sha256:page-1',
            spaceRunId: 'run-1',
            knowledgeGeneration: 1,
          },
          compileTaskId: 'task-1',
          finalAttempt: true,
          execution,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outcome: 'failed',
      code: 'input_too_large',
      retryable: false,
    });

    expect(compilationRepo.failAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'input_too_large',
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnosticClass: 'oversized',
        providerDiagnostic: expect.objectContaining({
          providerCode: 'context_length_exceeded',
          requestId: 'req-1',
        }),
      }),
    );
    warnSpy.mockRestore();
  });
});
