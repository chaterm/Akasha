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
            spaceRunId: 'run-1',
            knowledgeGeneration: 1,
            images: [],
            expectedExtractionIds: [],
          },
          compileTaskId: 'merge-1',
          execution,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual(expect.objectContaining({ outcome: 'noop' }));
    expect(execution.isActive).toHaveBeenCalled();
  });

  it('records degraded output without re-enqueuing the page for self-healing', async () => {
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
    const compiler = {
      compileSpace: jest.fn().mockResolvedValue({
        artifacts: [artifact],
        compilerRunId: 'fresh-compiler-run',
        resultQuality: 'degraded',
      }),
    };
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const importService = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
        embedding: {
          reusedCount: 7,
          generatedCount: 3,
          profileMismatchCount: 1,
        },
        largestSharedArtifact: {
          artifactId: 'concept-1',
          canonicalKey: 'processing_logic_subpage',
          chunkCount: 118,
        },
      }),
    };
    const compilationRepo = {
      startAttempt: jest.fn(),
      updateSourceSnapshot: jest.fn(),
      updateStage: jest.fn(),
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
          execution,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outcome: 'succeeded',
      result: { compilerRunId: 'fresh-compiler-run' },
    });

    expect(compiler.compileSpace).toHaveBeenCalled();
    expect(execution.catalog).toHaveBeenCalled();
    expect(importService.importCompileResult).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [artifact],
      }),
    );
    expect(compilationRepo.succeedAttempt).toHaveBeenCalled();
    expect(execution.completePage).toHaveBeenCalledWith({
      status: 'succeeded',
      qualityStatus: 'degraded',
    });
    expect(runRepo.requestRuns).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Knowledge publication sizing',
        sourcePageId: 'page-1',
        compileTaskId: 'retry-task',
        embeddingReused: 7,
        embeddingGenerated: 3,
        embeddingProfileMismatch: 1,
        largestSharedArtifactKey: 'processing_logic_subpage',
        largestSharedArtifactChunks: 118,
        sharedArtifactChunkLimit: 500,
      }),
    );
    logSpy.mockRestore();
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

  it('defers any page with images to the merge phase instead of compiling in the text phase', async () => {
    const source = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      contentHash: 'sha256:page-1',
      title: 'Page one',
      text: 'Page body with a diagram',
      references: [],
      images: [
        {
          attachmentId: 'attachment-1',
          attachmentVersion: '2026-08-03T00:00:00.000Z',
          fileName: 'diagram.png',
          mimeType: 'image/png',
          fileSize: 1024,
          altText: 'diagram',
        },
      ],
    };
    const compiler = { compileSpace: jest.fn() };
    const compilationRepo = {
      startAttempt: jest.fn(),
      updateSourceSnapshot: jest.fn(),
      skipAttempt: jest.fn(),
    };
    const imageEnrichment = {
      readReadySource: jest
        .fn()
        .mockResolvedValue({ source, readyImages: [], readyExtractionIds: [] }),
    };
    const service = new KnowledgePageCompilationService(
      { exportPageSources: jest.fn().mockResolvedValue([source]) } as never,
      compiler as never,
      {} as never,
      {} as never,
      compilationRepo as never,
      imageEnrichment as never,
    );
    const execution = {
      isActive: jest.fn().mockResolvedValue(true),
      markRunning: jest.fn(),
      completePage: jest.fn(),
      catalog: jest.fn().mockResolvedValue([]),
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
            spaceRunId: 'run-1',
            knowledgeGeneration: 1,
          },
          compileTaskId: 'task-1',
          execution,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome: 'noop' });

    // The text phase must never compile or publish an image page; that happens
    // exactly once in the merge phase after images reach a terminal state.
    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'awaiting_images' }),
    );
    expect(execution.completePage).toHaveBeenCalledWith({
      status: 'succeeded',
    });
  });

  it('merges text-only when every image extraction failed but the page has text', async () => {
    const pageImage = {
      attachmentId: 'attachment-1',
      attachmentVersion: '2026-08-03T00:00:00.000Z',
      fileName: 'diagram.png',
      mimeType: 'image/png' as const,
      fileSize: 1024,
      altText: 'diagram',
    };
    const source = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      contentHash: 'sha256:page-1',
      title: 'Page one',
      text: 'Page body with a diagram',
      references: [],
      images: [pageImage],
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
      compilerRunId: 'run',
      compileTaskId: 'task',
      chunks: [{ text: 'Page body with a diagram' }],
    };
    const compiler = {
      compileSpace: jest.fn().mockResolvedValue({
        artifacts: [artifact],
        compilerRunId: 'text-only-run',
        resultQuality: 'normal',
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
      skipAttempt: jest.fn(),
      succeedAttempt: jest.fn(),
      failAttempt: jest.fn(),
      updateStage: jest.fn(),
    };
    const accessIndexer = { reindexSourcePages: jest.fn() };
    const imageEnrichment = {
      // All extractions failed: no frozen extractions to resolve, no missing
      // ids, but the page text survives.
      readFrozenSource: jest.fn().mockResolvedValue({
        source,
        readyImages: [],
        readyExtractionIds: [],
        missingExtractionIds: [],
        truncatedCount: 0,
      }),
    };
    const service = new KnowledgePageCompilationService(
      { exportPageSources: jest.fn().mockResolvedValue([source]) } as never,
      compiler as never,
      importService as never,
      accessIndexer as never,
      compilationRepo as never,
      imageEnrichment as never,
    );
    const execution = {
      isActive: jest.fn().mockResolvedValue(true),
      completePage: jest.fn(),
      catalog: jest.fn().mockResolvedValue([]),
      publicationGuard: jest.fn(),
      publicationComplete: jest.fn().mockResolvedValue(true),
    };

    await expect(
      service.mergePageImages(
        {
          data: {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            sourceContentHash: 'sha256:page-1',
            spaceRunId: 'run-1',
            knowledgeGeneration: 1,
            images: [pageImage],
            expectedExtractionIds: [],
          },
          compileTaskId: 'merge-1',
          execution,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome: 'succeeded' });

    // Text-only fallback: a transient VLM failure must not strand a
    // text-bearing page without knowledge.
    expect(compiler.compileSpace).toHaveBeenCalled();
    expect(importService.importCompileResult).toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).not.toHaveBeenCalled();
  });

  it('re-plans instead of publishing when a frozen extraction can no longer be reproduced', async () => {
    const pageImage = {
      attachmentId: 'attachment-1',
      attachmentVersion: '2026-08-03T00:00:00.000Z',
      fileName: 'diagram.png',
      mimeType: 'image/png' as const,
      fileSize: 1024,
      altText: 'diagram',
    };
    const source = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      contentHash: 'sha256:page-1',
      title: 'Page one',
      text: 'Page body with a diagram',
      references: [],
      images: [pageImage],
    };
    const compiler = { compileSpace: jest.fn() };
    const compilationRepo = {
      startAttempt: jest.fn(),
      skipAttempt: jest.fn(),
    };
    const imageEnrichment = {
      // The frozen extraction can no longer be reproduced (re-extraction,
      // identity change, or deletion), so it comes back as a missing id — even
      // though a text-only fallback would otherwise be possible.
      readFrozenSource: jest.fn().mockResolvedValue({
        source,
        readyImages: [],
        readyExtractionIds: [],
        missingExtractionIds: ['extraction-frozen'],
        truncatedCount: 0,
      }),
    };
    const service = new KnowledgePageCompilationService(
      { exportPageSources: jest.fn().mockResolvedValue([source]) } as never,
      compiler as never,
      {} as never,
      {} as never,
      compilationRepo as never,
      imageEnrichment as never,
    );
    const execution = {
      isActive: jest.fn().mockResolvedValue(true),
      completePage: jest.fn(),
      catalog: jest.fn().mockResolvedValue([]),
      publicationGuard: jest.fn(),
      publicationComplete: jest.fn(),
    };

    await expect(
      service.mergePageImages(
        {
          data: {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            sourceContentHash: 'sha256:page-1',
            spaceRunId: 'run-1',
            knowledgeGeneration: 1,
            images: [pageImage],
            expectedExtractionIds: ['extraction-frozen'],
          },
          compileTaskId: 'merge-1',
          execution,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome: 'noop' });

    // A drifted extraction must never be published; the page re-plans via a
    // rerun-triggering error code instead.
    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'image_snapshot_changed' }),
    );
    expect(execution.completePage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        retryable: false,
        errorCode: 'image_snapshot_changed',
      }),
    );
  });

  it('skips without publishing when every image failed and the page has no text', async () => {
    const pageImage = {
      attachmentId: 'attachment-1',
      attachmentVersion: '2026-08-03T00:00:00.000Z',
      fileName: 'diagram.png',
      mimeType: 'image/png' as const,
      fileSize: 1024,
      altText: 'diagram',
    };
    const source = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      contentHash: 'sha256:page-1',
      title: 'Page one',
      text: '',
      references: [],
      images: [pageImage],
    };
    const compiler = { compileSpace: jest.fn() };
    const compilationRepo = {
      startAttempt: jest.fn(),
      skipAttempt: jest.fn(),
    };
    const imageEnrichment = {
      readFrozenSource: jest.fn().mockResolvedValue({
        source: { ...source, text: '' },
        readyImages: [],
        readyExtractionIds: [],
        missingExtractionIds: [],
        truncatedCount: 0,
      }),
    };
    const service = new KnowledgePageCompilationService(
      { exportPageSources: jest.fn().mockResolvedValue([source]) } as never,
      compiler as never,
      {} as never,
      {} as never,
      compilationRepo as never,
      imageEnrichment as never,
    );
    const execution = {
      isActive: jest.fn().mockResolvedValue(true),
      completePage: jest.fn(),
      catalog: jest.fn().mockResolvedValue([]),
      publicationGuard: jest.fn(),
      publicationComplete: jest.fn(),
    };

    await expect(
      service.mergePageImages(
        {
          data: {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            sourceContentHash: 'sha256:page-1',
            spaceRunId: 'run-1',
            knowledgeGeneration: 1,
            images: [pageImage],
            expectedExtractionIds: [],
          },
          compileTaskId: 'merge-1',
          execution,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome: 'noop' });

    // No text and no usable image knowledge: skip without touching prior
    // knowledge, using a non-rerun error code.
    expect(compiler.compileSpace).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'image_extraction_failed' }),
    );
    expect(execution.completePage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'skipped',
        errorCode: 'image_extraction_failed',
      }),
    );
  });
});
