import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';

describe('KnowledgeArtifactCatalogService', () => {
  it('retrieves a bounded identity-only analysis Catalog from source signals', async () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      candidate(index < 20 ? 'concept' : 'entity', index),
    );
    const capsuleRepo = {
      findCompilerCatalogCandidates: jest.fn().mockResolvedValue(rows),
    };
    const service = new KnowledgeArtifactCatalogService(
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
    );

    const result = await service.findAnalysisCandidates({
      source: sourceSnapshot(),
    });

    expect(result.entries).toHaveLength(24);
    expect(result.entries[0]).toEqual({
      artifactId: 'concept-0',
      artifactKind: 'concept',
      canonicalKey: 'concept-key-0',
      title: 'concept title 0',
    });
    expect(result.entries[0]).not.toHaveProperty('summary');
    expect(result.candidateHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(capsuleRepo.findCompilerCatalogCandidates).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      signals: ['Architecture notes', 'Event sourcing', 'Storage'],
      explicitSourcePageIds: ['page-2'],
      limit: 96,
    });
  });

  it('caps source summaries so semantic identities keep generation capacity', async () => {
    const rows = [
      ...Array.from({ length: 50 }, (_, index) =>
        candidate('source_summary', index),
      ),
      ...Array.from({ length: 60 }, (_, index) => candidate('concept', index)),
    ];
    const service = new KnowledgeArtifactCatalogService({
      findCompilerCatalogCandidates: jest.fn().mockResolvedValue(rows),
    } as unknown as KnowledgeCapsuleRepo);

    const result = await service.findGenerationCandidates({
      source: sourceSnapshot(),
      analysis: analysis(),
      analysisCandidates: [],
    });

    expect(result.entries).toHaveLength(64);
    expect(
      result.entries.filter((entry) => entry.artifactKind === 'source_summary'),
    ).toHaveLength(16);
  });

  it('produces a stable hash for the same ranked candidate identities', async () => {
    const capsuleRepo = {
      findCompilerCatalogCandidates: jest
        .fn()
        .mockResolvedValue([candidate('concept', 1)]),
    };
    const service = new KnowledgeArtifactCatalogService(
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
    );

    const first = await service.findAnalysisCandidates({
      source: sourceSnapshot(),
    });
    const second = await service.findAnalysisCandidates({
      source: sourceSnapshot(),
    });

    expect(second).toEqual(first);
  });
});

function candidate(
  artifactKind: 'source_summary' | 'concept' | 'entity' | 'comparison',
  index: number,
) {
  return {
    artifactId: `${artifactKind}-${index}`,
    artifactKind,
    canonicalKey: `${artifactKind}-key-${index}`,
    title: `${artifactKind} title ${index}`,
    explicitMatch: false,
    canonicalExactMatch: false,
    titleExactMatch: false,
    exactMatch: false,
    trigramScore: 1 - index / 1_000,
    ftsMatch: true,
  };
}

function sourceSnapshot() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'sha256:page-1',
    title: 'Architecture notes',
    text: '# Event sourcing\n## Storage\nBody',
    images: [],
    references: [
      {
        sourcePageId: 'page-1',
        targetPageId: 'page-2',
        targetSpaceId: 'space-1',
        kind: 'same_space_reference' as const,
        mode: 'opaque' as const,
      },
    ],
  };
}

function analysis() {
  return {
    version: '1' as const,
    synopsis: 'Architecture',
    language: 'en',
    entities: [],
    concepts: [
      {
        canonicalKey: 'event-sourcing',
        name: 'Event sourcing',
        description: 'Append-only storage',
        evidenceQuotes: ['append-only'],
      },
    ],
    claims: [],
    relations: [],
    comparisons: [],
    contradictions: [],
  };
}
