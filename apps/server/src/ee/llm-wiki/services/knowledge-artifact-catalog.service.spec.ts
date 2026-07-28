import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';

describe('KnowledgeArtifactCatalogService', () => {
  it('normalizes, bounds, and stable-sorts the active catalog', async () => {
    const capsuleRepo = {
      findActiveArtifactCatalog: jest.fn().mockResolvedValue([
        {
          artifactId: 'artifact-2',
          artifactKind: 'entity',
          canonicalKey: 'zeta',
          title: 'Zeta',
          body: 'x'.repeat(3_000),
        },
        {
          artifactId: 'artifact-1',
          artifactKind: 'concept',
          canonicalKey: 'alpha',
          title: 'Alpha',
          body: 'Alpha body',
        },
        {
          artifactId: 'artifact-ignored',
          artifactKind: 'overview',
          canonicalKey: 'overview',
          title: 'Overview',
          body: 'Old aggregate',
        },
      ]),
    };
    const service = new KnowledgeArtifactCatalogService(
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
    );

    const snapshot = await service.snapshot({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(snapshot.entries.map((entry) => entry.artifactId)).toEqual([
      'artifact-1',
      'artifact-2',
    ]);
    expect(snapshot.entries[1].summary).toHaveLength(2_000);
    expect(snapshot.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(
      service.snapshot({ workspaceId: 'workspace-1', spaceId: 'space-1' }),
    ).resolves.toEqual(snapshot);
  });

  it('fingerprints the exact deterministic aggregate input, including bodies and source refs', async () => {
    const candidates = {
      pages: [
        aggregatePage({
          id: 'artifact-b',
          pageType: 'entity',
          canonicalKey: 'beta',
          body: 'Beta body',
        }),
        aggregatePage({
          id: 'artifact-a',
          pageType: 'concept',
          canonicalKey: 'alpha',
          body: 'Alpha body',
        }),
        aggregatePage({
          id: 'overview',
          pageType: 'overview',
          canonicalKey: 'overview',
          body: 'Volatile overview',
        }),
      ],
      pageSources: [
        aggregateSource('artifact-b', 'page-2', 'v2', 'hash-2'),
        aggregateSource('artifact-a', 'page-1', 'v1', 'hash-1'),
      ],
    };
    const capsuleRepo = {
      findAggregateCandidatesForSpace: jest.fn().mockResolvedValue(candidates),
      countActiveAggregateArtifacts: jest.fn().mockResolvedValue(2),
    };
    const service = new KnowledgeArtifactCatalogService(
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
    );

    const first = await service.aggregateInput({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(first.pages.map((page) => page.id)).toEqual([
      'artifact-a',
      'artifact-b',
    ]);
    expect(first.allSourceRefs.map((source) => source.sourcePageId)).toEqual([
      'page-1',
      'page-2',
    ]);
    expect(first.fingerprint).toEqual({
      hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      artifactCount: 2,
      truncated: false,
    });

    candidates.pages[1] = {
      ...candidates.pages[1],
      updatedAt: new Date('2099-01-01T00:00:00.000Z'),
    };
    const timestampOnly = await service.aggregateFingerprint({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(timestampOnly.hash).toBe(first.fingerprint.hash);

    candidates.pages[1] = {
      ...candidates.pages[1],
      body: 'Changed Alpha body',
    };
    const bodyChanged = await service.aggregateFingerprint({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(bodyChanged.hash).not.toBe(first.fingerprint.hash);

    candidates.pages[1] = {
      ...candidates.pages[1],
      body: 'Alpha body',
    };
    candidates.pageSources[1] = aggregateSource(
      'artifact-a',
      'page-1',
      'v2',
      'hash-new',
    );
    const sourceChanged = await service.aggregateFingerprint({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(sourceChanged.hash).not.toBe(first.fingerprint.hash);
  });

  it('keeps 5,000 allowed artifacts when an overview exists outside the aggregate input', async () => {
    const allowedPages = Array.from({ length: 5_000 }, (_, index) =>
      aggregatePage({
        id: `artifact-${String(index).padStart(4, '0')}`,
        pageType: 'concept',
        canonicalKey: `concept-${String(index).padStart(4, '0')}`,
      }),
    );
    const capsuleRepo = {
      findAggregateCandidatesForSpace: jest.fn().mockResolvedValue({
        pages: [
          ...allowedPages,
          aggregatePage({
            id: 'overview',
            pageType: 'overview',
            canonicalKey: 'overview',
          }),
        ],
        pageSources: allowedPages.map((page, index) =>
          aggregateSource(page.id, `page-${index}`, 'v1', `hash-${index}`),
        ),
      }),
      countActiveAggregateArtifacts: jest.fn().mockResolvedValue(5_000),
      findGraphCandidatesForSpace: jest.fn(),
    };
    const service = new KnowledgeArtifactCatalogService(
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
    );

    const result = await service.aggregateInput({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(result.pages).toHaveLength(5_000);
    expect(result.pages.some((page) => page.pageType === 'overview')).toBe(
      false,
    );
    expect(result.fingerprint.truncated).toBe(false);
    expect(capsuleRepo.findAggregateCandidatesForSpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      limit: 5_000,
    });
    expect(capsuleRepo.findGraphCandidatesForSpace).not.toHaveBeenCalled();
  });
});

function aggregatePage(overrides: Record<string, unknown>) {
  return {
    id: 'artifact',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    compileScope: 'page',
    title: 'Artifact',
    slug: 'artifact',
    pageType: 'concept',
    body: 'Body',
    summary: null,
    compiledAt: new Date('2026-01-01T00:00:00.000Z'),
    compilerVersion: 'compiler-v1',
    compilerRunId: 'run-1',
    compileTaskId: 'task-1',
    staleAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    generationMode: 'semantic',
    canonicalKey: 'artifact',
    ...overrides,
  };
}

function aggregateSource(
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
