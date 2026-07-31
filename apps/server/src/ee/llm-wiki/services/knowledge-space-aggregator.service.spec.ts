import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { KnowledgeCompilerLlmProvider } from '../compiler/knowledge-compiler-llm.provider';
import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import { KnowledgeImportService } from './knowledge-import.service';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { KnowledgeSpaceAggregatorService } from './knowledge-space-aggregator.service';
import { buildAggregatePrompt } from './knowledge-space-aggregator.service';
import { KnowledgeLinkResolverService } from './knowledge-link-resolver.service';

describe('KnowledgeSpaceAggregatorService', () => {
  it('bounds a representative large-Space narrative prompt', () => {
    const pages = Array.from({ length: 1_000 }, (_, index) =>
      page(
        `artifact-${index}`,
        'concept',
        `concept-${String(index).padStart(4, '0')}`,
        `Concept ${index}`,
        'x'.repeat(2_000),
      ),
    );

    const prompt = buildAggregatePrompt(pages);

    expect(prompt.length).toBeLessThanOrEqual(120_000);
    expect(prompt).toContain('total="1000"');
    expect(prompt).toContain('sampled="100"');
    expect(prompt).toContain('concept-0000');
    expect(prompt).toContain('concept-0990');
  });

  it('uses one 300 second phase deadline and never completes after timeout', async () => {
    jest.useFakeTimers();
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-timeout',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        knowledgeGeneration: 1,
      }),
      completeAggregation: jest.fn(),
    };
    const provider = {
      completeMerge: jest.fn(
        (_messages, options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal.addEventListener(
              'abort',
              () => reject(options.abortSignal.reason),
              { once: true },
            );
          }),
      ),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as never,
      {
        aggregateInput: jest
          .fn()
          .mockResolvedValue(aggregateInputFixture('sha256:timeout')),
      } as never,
      provider as never,
      { importCompileResult: jest.fn() } as never,
      { resolveSpace: jest.fn() } as never,
      { getKnowledgeAggregateDeadlineMs: jest.fn(() => 300_000) } as never,
    );

    const operation = service.aggregate({
      runId: 'run-timeout',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(300_000);

    await expect(operation).rejects.toMatchObject({ code: 'timeout' });
    expect(runRepo.completeAggregation).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('classifies a deadline reached during catalog loading as aggregate timeout', async () => {
    jest.useFakeTimers();
    const service = new KnowledgeSpaceAggregatorService(
      {
        startAggregation: jest.fn().mockResolvedValue({
          id: 'run-catalog-timeout',
          compilerVersion: 'compiler-v1',
          promptVersion: 'prompt-v1',
        }),
      } as never,
      {
        aggregateInput: jest.fn(
          ({ abortSignal }) =>
            new Promise((_resolve, reject) => {
              abortSignal.addEventListener(
                'abort',
                () => reject(abortSignal.reason),
                { once: true },
              );
            }),
        ),
      } as never,
      { completeMerge: jest.fn() } as never,
      { importCompileResult: jest.fn() } as never,
      { resolveSpace: jest.fn() } as never,
      { getKnowledgeAggregateDeadlineMs: jest.fn(() => 300_000) } as never,
    );

    const operation = service.aggregate({
      runId: 'run-catalog-timeout',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(300_000);

    await expect(operation).rejects.toMatchObject({
      code: 'timeout',
      message: 'Knowledge aggregate phase timed out.',
    });
    jest.useRealTimers();
  });

  it('publishes an LLM overview plus a deterministic complete catalog', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
      findRun: jest.fn().mockResolvedValue({ status: 'aggregating' }),
      completeAggregation: jest.fn().mockResolvedValue(undefined),
    };
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [
          page('artifact-z', 'entity', 'zeta', 'Zeta', 'Zeta body'),
          page('artifact-a', 'concept', 'alpha', 'Alpha', 'Alpha body'),
          page('old-overview', 'overview', 'overview', 'Old', 'Old body'),
        ],
        pageSources: [
          pageSource('artifact-a', 'page-1', 'v1', 'hash-1'),
          pageSource('artifact-z', 'page-2', 'v2', 'hash-2'),
        ],
        parentSections: [],
        parentSectionSources: [],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      }),
    };
    const provider = {
      completeMerge: jest.fn().mockResolvedValue(
        JSON.stringify({
          title: 'Space overview',
          markdown: '# Space overview\n\nA concise synthesis.',
        }),
      ),
    };
    const importer = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    };
    const linkResolver = {
      resolveSpace: jest.fn().mockResolvedValue({ resolvedLinkCount: 1 }),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      aggregateCatalog(capsuleRepo),
      provider as unknown as KnowledgeCompilerLlmProvider,
      importer as unknown as KnowledgeImportService,
      linkResolver as unknown as KnowledgeLinkResolverService,
    );

    await expect(
      service.aggregate({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    );

    expect(provider.completeMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('untrusted'),
        prompt: expect.stringContaining('Alpha body'),
      }),
      { abortSignal: expect.any(AbortSignal) },
    );
    const importCall = importer.importCompileResult.mock.calls[0][0];
    expect(importCall.upsertSources).toBe(false);
    expect(importCall.input).toEqual(
      expect.objectContaining({ compileMode: 'space' }),
    );
    expect(importCall.artifacts).toHaveLength(1);
    expect(importCall.artifacts[0]).toEqual(
      expect.objectContaining({
        artifactKind: 'overview',
        canonicalKey: 'overview',
        generationMode: 'semantic',
        contentMarkdown: expect.stringContaining('## Knowledge catalog'),
      }),
    );
    expect(importCall.artifacts[0].chunks[0].stableKey).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(
      importCall.artifacts[0].contentMarkdown.indexOf('Alpha'),
    ).toBeLessThan(importCall.artifacts[0].contentMarkdown.indexOf('Zeta'));
    expect(importCall.artifacts[0].links).toEqual([
      expect.objectContaining({ toKnowledgePageId: 'artifact-a' }),
      expect.objectContaining({ toKnowledgePageId: 'artifact-z' }),
    ]);
    expect(runRepo.completeAggregation).toHaveBeenCalledWith({
      runId: 'run-1',
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
      catalogHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(linkResolver.resolveSpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      abortSignal: expect.any(AbortSignal),
    });
  });

  it('stores the fingerprint actually consumed even when page artifacts change after the read', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
      findRun: jest.fn().mockResolvedValue({ status: 'aggregating' }),
      completeAggregation: jest.fn().mockResolvedValue(undefined),
    };
    const artifactCatalog = {
      aggregateInput: jest
        .fn()
        .mockResolvedValue(aggregateInputFixture('sha256:consumed-input')),
      aggregateFingerprint: jest.fn().mockResolvedValue({
        hash: 'sha256:published-after-read',
      }),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      artifactCatalog as unknown as KnowledgeArtifactCatalogService,
      {
        completeMerge: jest
          .fn()
          .mockResolvedValue(
            JSON.stringify({ title: 'Overview', markdown: 'Consumed body' }),
          ),
      } as unknown as KnowledgeCompilerLlmProvider,
      {
        importCompileResult: jest.fn().mockResolvedValue({
          importedArtifactCount: 1,
          quarantinedArtifactCount: 0,
        }),
      } as unknown as KnowledgeImportService,
      {
        resolveSpace: jest.fn().mockResolvedValue(undefined),
      } as unknown as KnowledgeLinkResolverService,
    );

    await service.aggregate({
      runId: 'run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(runRepo.completeAggregation).toHaveBeenCalledWith(
      expect.objectContaining({ catalogHash: 'sha256:consumed-input' }),
    );
    expect(artifactCatalog.aggregateFingerprint).not.toHaveBeenCalled();
  });

  it('keeps the run open in images phase after its initial aggregate', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-images',
        phase: 'initial_aggregate',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
      findRun: jest.fn().mockResolvedValue({ status: 'aggregating' }),
      hasPendingImagePages: jest.fn().mockResolvedValue(true),
      completeAggregation: jest.fn().mockResolvedValue(undefined),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      {
        aggregateInput: jest
          .fn()
          .mockResolvedValue(aggregateInputFixture('sha256:initial')),
      } as unknown as KnowledgeArtifactCatalogService,
      {
        completeMerge: jest
          .fn()
          .mockResolvedValue(
            JSON.stringify({ title: 'Overview', markdown: 'Text overview' }),
          ),
      } as unknown as KnowledgeCompilerLlmProvider,
      {
        importCompileResult: jest.fn().mockResolvedValue({
          importedArtifactCount: 1,
          quarantinedArtifactCount: 0,
        }),
      } as unknown as KnowledgeImportService,
      {
        resolveSpace: jest.fn().mockResolvedValue(undefined),
      } as unknown as KnowledgeLinkResolverService,
    );

    await service.aggregate({
      runId: 'run-images',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(runRepo.completeAggregation).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'initial_aggregate' }),
    );
  });

  it('safely retries the same aggregating run after publication crashes before completion', async () => {
    const run = {
      id: 'run-1',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    };
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue(run),
      findRun: jest.fn().mockResolvedValue({ status: 'aggregating' }),
      completeAggregation: jest
        .fn()
        .mockRejectedValueOnce(new Error('crash after publication'))
        .mockResolvedValueOnce(undefined),
    };
    const artifactCatalog = {
      aggregateInput: jest
        .fn()
        .mockResolvedValue(aggregateInputFixture('sha256:consumed-input')),
    };
    const importer = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      artifactCatalog as unknown as KnowledgeArtifactCatalogService,
      {
        completeMerge: jest
          .fn()
          .mockResolvedValue(
            JSON.stringify({ title: 'Overview', markdown: 'Idempotent body' }),
          ),
      } as unknown as KnowledgeCompilerLlmProvider,
      importer as unknown as KnowledgeImportService,
      {
        resolveSpace: jest.fn().mockResolvedValue(undefined),
      } as unknown as KnowledgeLinkResolverService,
    );
    const input = {
      runId: 'run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    };

    await expect(service.aggregate(input)).rejects.toThrow(
      'crash after publication',
    );
    await expect(service.aggregate(input)).resolves.toEqual(
      expect.objectContaining({ importedArtifactCount: 1 }),
    );

    expect(runRepo.startAggregation).toHaveBeenCalledTimes(2);
    expect(importer.importCompileResult).toHaveBeenCalledTimes(2);
    expect(runRepo.completeAggregation).toHaveBeenLastCalledWith(
      expect.objectContaining({ catalogHash: 'sha256:consumed-input' }),
    );
  });

  it('safely retries the same run after a crash immediately after aggregation starts', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
      findRun: jest.fn().mockResolvedValue({ status: 'aggregating' }),
      completeAggregation: jest.fn().mockResolvedValue(undefined),
    };
    const artifactCatalog = {
      aggregateInput: jest
        .fn()
        .mockRejectedValueOnce(new Error('crash after start'))
        .mockResolvedValueOnce(aggregateInputFixture('sha256:consumed-input')),
    };
    const importer = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 1,
        quarantinedArtifactCount: 0,
      }),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      artifactCatalog as unknown as KnowledgeArtifactCatalogService,
      {
        completeMerge: jest
          .fn()
          .mockResolvedValue(
            JSON.stringify({ title: 'Overview', markdown: 'Recovered body' }),
          ),
      } as unknown as KnowledgeCompilerLlmProvider,
      importer as unknown as KnowledgeImportService,
      {
        resolveSpace: jest.fn().mockResolvedValue(undefined),
      } as unknown as KnowledgeLinkResolverService,
    );
    const input = {
      runId: 'run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    };

    await expect(service.aggregate(input)).rejects.toThrow('crash after start');
    await expect(service.aggregate(input)).resolves.toEqual(
      expect.objectContaining({ importedArtifactCount: 1 }),
    );

    expect(runRepo.startAggregation).toHaveBeenCalledTimes(2);
    expect(importer.importCompileResult).toHaveBeenCalledTimes(1);
    expect(runRepo.completeAggregation).toHaveBeenCalledTimes(1);
  });

  it('completes an obsolete aggregate job as a no-op', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue(undefined),
      completeAggregation: jest.fn(),
    };
    const capsuleRepo = { findGraphCandidatesForSpace: jest.fn() };
    const provider = { completeMerge: jest.fn() };
    const importer = { importCompileResult: jest.fn() };
    const linkResolver = { resolveSpace: jest.fn() };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      aggregateCatalog(capsuleRepo),
      provider as unknown as KnowledgeCompilerLlmProvider,
      importer as unknown as KnowledgeImportService,
      linkResolver as unknown as KnowledgeLinkResolverService,
    );

    await expect(
      service.aggregate({
        runId: 'superseded-run',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
    });

    expect(capsuleRepo.findGraphCandidatesForSpace).not.toHaveBeenCalled();
    expect(provider.completeMerge).not.toHaveBeenCalled();
    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(linkResolver.resolveSpace).not.toHaveBeenCalled();
    expect(runRepo.completeAggregation).not.toHaveBeenCalled();
  });

  it('does not publish an overview when the run is superseded during the LLM call', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
      findRun: jest.fn().mockResolvedValue({ status: 'superseded' }),
      completeAggregation: jest.fn(),
    };
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [page('artifact-a', 'concept', 'alpha', 'Alpha', 'Body')],
        pageSources: [pageSource('artifact-a', 'page-1', 'v1', 'hash-1')],
      }),
    };
    const provider = {
      completeMerge: jest
        .fn()
        .mockResolvedValue(
          JSON.stringify({ title: 'Overview', markdown: 'Overview body' }),
        ),
    };
    const importer = { importCompileResult: jest.fn() };
    const linkResolver = { resolveSpace: jest.fn() };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      aggregateCatalog(capsuleRepo),
      provider as unknown as KnowledgeCompilerLlmProvider,
      importer as unknown as KnowledgeImportService,
      linkResolver as unknown as KnowledgeLinkResolverService,
    );

    await expect(
      service.aggregate({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
    });

    expect(provider.completeMerge).toHaveBeenCalledTimes(1);
    expect(importer.importCompileResult).not.toHaveBeenCalled();
    expect(linkResolver.resolveSpace).not.toHaveBeenCalled();
    expect(runRepo.completeAggregation).not.toHaveBeenCalled();
  });

  it('classifies an invalid aggregate contract as non-retryable output', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
    };
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [page('artifact-a', 'concept', 'alpha', 'Alpha', 'Body')],
        pageSources: [pageSource('artifact-a', 'page-1', 'v1', 'hash-1')],
        parentSections: [],
        parentSectionSources: [],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      }),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      aggregateCatalog(capsuleRepo),
      {
        completeMerge: jest
          .fn()
          .mockResolvedValue('{"title":"","markdown":""}'),
      } as unknown as KnowledgeCompilerLlmProvider,
      { importCompileResult: jest.fn() } as unknown as KnowledgeImportService,
      {
        resolveSpace: jest.fn(),
      } as unknown as KnowledgeLinkResolverService,
    );

    const error = await service
      .aggregate({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      })
      .catch((value) => value);

    expect(error).toBeInstanceOf(KnowledgeCompilerLlmError);
    expect(error).toMatchObject({ code: 'invalid_output', retryable: false });
  });

  it('retires the previous Space package when no active page artifacts remain', async () => {
    const publicationTrx = { id: 'empty-space-publication-trx' };
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-empty',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
      findRun: jest.fn().mockResolvedValue({ status: 'aggregating' }),
      isRunActiveForPublication: jest.fn().mockResolvedValue(true),
      completeAggregation: jest.fn().mockResolvedValue(undefined),
    };
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [],
        pageSources: [],
        parentSections: [],
        parentSectionSources: [],
        links: [],
        linkSources: [],
        graphEdges: [],
        graphEdgeSources: [],
      }),
    };
    const provider = { completeMerge: jest.fn() };
    const importer = {
      importCompileResult: jest.fn().mockImplementation(async (input) => {
        await input.publicationGuard(publicationTrx);
        return { importedArtifactCount: 0, quarantinedArtifactCount: 0 };
      }),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      aggregateCatalog(capsuleRepo),
      provider as unknown as KnowledgeCompilerLlmProvider,
      importer as unknown as KnowledgeImportService,
      { resolveSpace: jest.fn() } as unknown as KnowledgeLinkResolverService,
    );

    await expect(
      service.aggregate({
        runId: 'run-empty',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
    });

    expect(importer.importCompileResult).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [],
        upsertSources: false,
        retireCompileScope: true,
      }),
    );
    expect(runRepo.isRunActiveForPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-empty',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
      publicationTrx,
    );
    expect(provider.completeMerge).not.toHaveBeenCalled();
  });

  it('does not complete an empty aggregation rejected by the publication fence', async () => {
    const runRepo = {
      startAggregation: jest.fn().mockResolvedValue({
        id: 'run-empty',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
      findRun: jest.fn().mockResolvedValue({ status: 'aggregating' }),
      completeAggregation: jest.fn(),
    };
    const capsuleRepo = {
      findGraphCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [],
        pageSources: [],
      }),
      markCompileScopeStale: jest.fn().mockResolvedValue(undefined),
    };
    const importer = {
      importCompileResult: jest.fn().mockResolvedValue({
        importedArtifactCount: 0,
        quarantinedArtifactCount: 0,
        skippedReason: 'run_superseded',
      }),
    };
    const service = new KnowledgeSpaceAggregatorService(
      runRepo as unknown as KnowledgeSpaceCompilationRepo,
      aggregateCatalog(capsuleRepo),
      { completeMerge: jest.fn() } as unknown as KnowledgeCompilerLlmProvider,
      importer as unknown as KnowledgeImportService,
      { resolveSpace: jest.fn() } as unknown as KnowledgeLinkResolverService,
    );

    await expect(
      service.aggregate({
        runId: 'run-empty',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
    });

    expect(runRepo.completeAggregation).not.toHaveBeenCalled();
  });
});

function page(
  id: string,
  pageType: string,
  canonicalKey: string,
  title: string,
  body: string,
) {
  return {
    id,
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: pageType === 'overview' ? 'space' : 'page',
    title,
    slug: id,
    pageType,
    body,
    summary: null,
    compiledAt: new Date(),
    compilerVersion: 'compiler-v1',
    compilerRunId: 'page-run',
    compileTaskId: 'page-task',
    staleAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    generationMode: pageType === 'overview' ? 'legacy' : 'semantic',
    canonicalKey,
  };
}

function pageSource(
  knowledgePageId: string,
  sourcePageId: string,
  sourceVersion: string,
  contentHash: string,
) {
  return {
    workspaceId: 'workspace-1',
    knowledgePageId,
    sourcePageId,
    attachmentId: null,
    sourceVersion,
    sourceRange: null,
    quoteHash: null,
    contentHash,
    provenanceKind: 'synthesis_lineage',
  };
}

function aggregateInputFixture(hash: string) {
  const artifact = page(
    'artifact-a',
    'concept',
    'alpha',
    'Alpha',
    'Alpha body',
  );
  const source = {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'hash-1',
  };
  return {
    pages: [artifact],
    sourceRefsByArtifact: new Map([[artifact.id, [source]]]),
    allSourceRefs: [source],
    fingerprint: { hash, artifactCount: 1, truncated: false },
  };
}

function aggregateCatalog(
  capsuleRepo: Record<string, jest.Mock>,
): KnowledgeArtifactCatalogService {
  capsuleRepo.findAggregateCandidatesForSpace ??=
    capsuleRepo.findGraphCandidatesForSpace;
  capsuleRepo.countActiveAggregateArtifacts ??= jest
    .fn()
    .mockImplementation(async () => {
      const candidates = await capsuleRepo.findAggregateCandidatesForSpace();
      return (candidates?.pages ?? []).filter(
        (candidate: { pageType?: string }) =>
          ['source_summary', 'concept', 'entity', 'comparison'].includes(
            candidate.pageType ?? '',
          ),
      ).length;
    });
  return new KnowledgeArtifactCatalogService(
    capsuleRepo as unknown as KnowledgeCapsuleRepo,
  );
}
