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
});
