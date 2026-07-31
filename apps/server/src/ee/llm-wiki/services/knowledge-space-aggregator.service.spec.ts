import { KnowledgeCompilerLlmError } from '../compiler/knowledge-compiler-llm.provider';
import {
  KnowledgeSpaceAggregatorService,
  buildAggregatePrompt,
} from './knowledge-space-aggregator.service';

describe('KnowledgeSpaceAggregatorService', () => {
  it('bounds a representative large-Space narrative prompt', () => {
    const prompt = buildAggregatePrompt(
      Array.from({ length: 5_000 }, (_, index) => ({
        id: `artifact-${index}`,
        pageType: 'concept',
        canonicalKey: `artifact-${index}`,
        title: `Artifact ${index}`,
        body: 'x'.repeat(2_000),
      })),
    );

    expect(prompt.length).toBeLessThanOrEqual(120_000);
    expect(prompt.match(/<artifact kind=/g)?.length).toBeLessThanOrEqual(100);
    expect(prompt.endsWith('</artifact_catalog_sample>')).toBe(true);
  });

  it('publishes aggregate output only through the active Space lease', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.aggregateLeased(lease(), {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
      catalogHash: 'sha256:catalog',
    });

    expect(fixture.executionRepo.isLeaseActive).toHaveBeenCalledWith(lease());
    expect(
      fixture.executionRepo.isLeaseActiveForSpacePublication,
    ).toHaveBeenCalledWith(lease(), expect.anything());
    expect(fixture.importService.importCompileResult).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [
          expect.objectContaining({
            artifactKind: 'overview',
            compilerRunId: 'run-1',
          }),
        ],
        publicationGuard: expect.any(Function),
      }),
    );
    expect(fixture.linkResolver.resolveSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it('returns a no-op before catalog work when the lease is obsolete', async () => {
    const fixture = createFixture();
    fixture.executionRepo.findLeasedRun.mockResolvedValue(undefined);

    await expect(
      fixture.service.aggregateLeased(lease(), {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
      catalogHash: undefined,
    });
    expect(fixture.artifactCatalog.aggregateInput).not.toHaveBeenCalled();
    expect(fixture.provider.completeMerge).not.toHaveBeenCalled();
  });

  it('retires the prior overview through the lease when no artifacts remain', async () => {
    const fixture = createFixture({ empty: true });

    await expect(
      fixture.service.aggregateLeased(lease(), {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      importedArtifactCount: 0,
      quarantinedArtifactCount: 0,
      catalogHash: 'sha256:catalog',
    });
    expect(fixture.importService.importCompileResult).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: [],
        upsertSources: false,
        retireCompileScope: true,
        publicationGuard: expect.any(Function),
      }),
    );
  });

  it('applies one hard deadline to the entire leased aggregate phase', async () => {
    jest.useFakeTimers();
    const fixture = createFixture({ deadlineMs: 300_000 });
    fixture.provider.completeMerge.mockImplementation(
      (_input: unknown, options: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(options.abortSignal?.reason),
            { once: true },
          );
        }),
    );

    const operation = fixture.service.aggregateLeased(lease(), {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    for (
      let index = 0;
      index < 20 && fixture.provider.completeMerge.mock.calls.length === 0;
      index += 1
    ) {
      await Promise.resolve();
    }
    expect(fixture.provider.completeMerge).toHaveBeenCalledTimes(1);
    const timeoutExpectation = expect(operation).rejects.toEqual(
      expect.objectContaining<Partial<KnowledgeCompilerLlmError>>({
        code: 'timeout',
        retryable: true,
      }),
    );
    await jest.advanceTimersByTimeAsync(300_000);

    await timeoutExpectation;
    expect(fixture.importService.importCompileResult).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

function createFixture(options: { empty?: boolean; deadlineMs?: number } = {}) {
  const sourceRef = {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'sha256:page-1',
  };
  const page = {
    id: 'artifact-1',
    pageType: 'concept',
    canonicalKey: 'concept:one',
    title: 'Concept one',
    body: 'Body',
  };
  const artifactCatalog = {
    aggregateInput: jest.fn().mockResolvedValue({
      pages: options.empty ? [] : [page],
      sourceRefsByArtifact: new Map([[page.id, [sourceRef]]]),
      allSourceRefs: options.empty ? [] : [sourceRef],
      fingerprint: { hash: 'sha256:catalog' },
    }),
  };
  const provider = {
    completeMerge: jest
      .fn()
      .mockResolvedValue(
        JSON.stringify({ title: 'Overview', markdown: 'Narrative' }),
      ),
  };
  const executionRepo = {
    findLeasedRun: jest.fn().mockResolvedValue({
      phase: 'initial_aggregate',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
      catalogHash: 'sha256:old',
    }),
    isLeaseActive: jest.fn().mockResolvedValue(true),
    isLeaseActiveForSpacePublication: jest.fn().mockResolvedValue(true),
  };
  const importService = {
    importCompileResult: jest.fn().mockImplementation(async (input) => {
      await input.publicationGuard({ transaction: true });
      return { importedArtifactCount: 1, quarantinedArtifactCount: 0 };
    }),
  };
  const linkResolver = { resolveSpace: jest.fn() };
  const environmentService = {
    getKnowledgeAggregateDeadlineMs: jest
      .fn()
      .mockReturnValue(options.deadlineMs ?? 300_000),
  };
  const service = new KnowledgeSpaceAggregatorService(
    artifactCatalog as never,
    provider as never,
    importService as never,
    linkResolver as never,
    environmentService as never,
    executionRepo as never,
  );
  return {
    service,
    artifactCatalog,
    provider,
    executionRepo,
    importService,
    linkResolver,
  };
}

function lease() {
  return {
    runId: 'run-1',
    knowledgeGeneration: 4,
    jobPhase: 'text' as const,
    spaceJobSequence: 1,
    spaceJobId: 'knowledge-space-text__run-1__text__1',
    executionToken: 'execution-token',
  };
}
