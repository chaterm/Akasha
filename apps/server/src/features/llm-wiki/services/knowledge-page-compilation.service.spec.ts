import { Logger } from '@nestjs/common';
import { PostgresError } from 'postgres';
import { runKnowledgeCompilationOperation } from '../../../common/helpers/knowledge-compilation-error';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import { KnowledgePageCompilationService } from './knowledge-page-compilation.service';

describe('KnowledgePageCompilationService contract', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['text', 'image'] as const)(
    'persists and logs database failure details for %s publication',
    async (kind) => {
      const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const error = Object.assign(new PostgresError(''), {
        code: '23505',
        table_name: 'knowledge_chunks',
        constraint_name: 'knowledge_chunks_pkey',
        detail: 'sensitive-page-body',
        query: 'INSERT sensitive-page-body',
        parameters: ['sensitive-page-body'],
      });
      const fixture = failureFixture(async () =>
        runKnowledgeCompilationOperation(
          'import.insert.knowledgeChunks',
          async () => {
            throw error;
          },
        ),
      );
      const outcome = await fixture.run(kind);
      expect(outcome).toMatchObject({
        outcome: 'failed',
        code: 'compile_failed',
        retryable: true,
        cause: error,
      });
      const failure = fixture.compilationRepo.failAttempt.mock.calls[0][0];
      expect(failure.errorCode).toBe('compile_failed');
      expect(failure.errorMessage).toContain('[import.insert.knowledgeChunks]');
      expect(failure.errorMessage).toContain('sqlState=23505');
      expect(failure.errorMessage).toContain('table=knowledge_chunks');
      expect(failure.errorMessage).toContain(
        'constraint=knowledge_chunks_pkey',
      );
      expect(fixture.execution.completePage).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
          retryable: true,
        }),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'knowledge_page_compilation_failed',
          sourcePageId: 'page-1',
          compileTaskId: 'task-1',
          operation: 'import.insert.knowledgeChunks',
          database: expect.objectContaining({ sqlState: '23505' }),
        }),
      );
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(
        'sensitive-page-body',
      );
      expect(failure.errorMessage).not.toContain('sensitive-page-body');
    },
  );

  it('retains the reason for an ordinary compilation error', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const fixture = failureFixture(async () => {
      throw new TypeError('Cannot read properties of undefined');
    });
    await expect(fixture.run('text')).resolves.toMatchObject({
      outcome: 'failed',
      code: 'compile_failed',
      message: 'TypeError: Cannot read properties of undefined',
      retryable: true,
    });
    expect(fixture.compilationRepo.failAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: 'TypeError: Cannot read properties of undefined',
      }),
    );
  });

  it('distinguishes an access-index failure after a successful import', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const fixture = failureFixture(async () => ({
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
    }));
    fixture.accessIndexer.reindexSourcePages.mockRejectedValue(
      new Error('Permission snapshot failed'),
    );
    await expect(fixture.run('text')).resolves.toMatchObject({
      outcome: 'failed',
      message:
        '[access_index.reindex_source_pages] Error: Permission snapshot failed',
    });
    expect(fixture.compilationRepo.succeedAttempt).not.toHaveBeenCalled();
  });

  it('preserves propagation of image-merge source read errors', async () => {
    const fixture = failureFixture(async () => ({}));
    const error = new Error('Source read failed');
    fixture.sourceExporter.exportPageSources.mockRejectedValue(error);
    await expect(fixture.run('image')).rejects.toBe(error);
    expect(fixture.compilationRepo.failAttempt).not.toHaveBeenCalled();
    expect(fixture.execution.completePage).not.toHaveBeenCalled();
  });

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
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
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

function failureFixture(importResult: () => Promise<unknown>) {
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
  const compilationRepo = {
    startAttempt: jest.fn(),
    updateSourceSnapshot: jest.fn(),
    updateStage: jest.fn(),
    succeedAttempt: jest.fn(),
    failAttempt: jest.fn(),
    skipAttempt: jest.fn(),
  };
  const accessIndexer = { reindexSourcePages: jest.fn() };
  const sourceExporter = {
    exportPageSources: jest.fn().mockResolvedValue([source]),
  };
  const service = new KnowledgePageCompilationService(
    sourceExporter as never,
    {
      compileSpace: jest.fn().mockResolvedValue({
        artifacts: [],
        compilerRunId: 'run-1',
      }),
    } as never,
    { importCompileResult: jest.fn(importResult) } as never,
    accessIndexer as never,
    compilationRepo as never,
    {
      readFrozenSource: jest.fn().mockResolvedValue({
        source,
        readyImages: [],
        missingExtractionIds: [],
      }),
    } as never,
  );
  const execution = {
    isActive: jest.fn().mockResolvedValue(true),
    completePage: jest.fn(),
    catalog: jest.fn().mockResolvedValue([]),
    publicationGuard: jest.fn(),
    publicationComplete: jest.fn(),
  };
  const data = {
    workspaceId: source.workspaceId,
    spaceId: source.spaceId,
    spaceRunId: 'run-1',
    knowledgeGeneration: 1,
    sourcePageId: source.sourcePageId,
    sourcePageIds: [source.sourcePageId],
    sourceVersion: source.sourceVersion,
    sourceContentHash: source.contentHash,
    images: [],
    expectedExtractionIds: [],
  };
  return {
    compilationRepo,
    accessIndexer,
    sourceExporter,
    execution,
    run: (kind: 'text' | 'image') =>
      service[kind === 'text' ? 'compileTextPage' : 'mergePageImages'](
        { data, compileTaskId: 'task-1', execution },
        new AbortController().signal,
      ),
  };
}
