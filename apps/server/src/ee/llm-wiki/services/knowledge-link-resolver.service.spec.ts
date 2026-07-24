import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeLinkResolverService } from './knowledge-link-resolver.service';

describe('KnowledgeLinkResolverService', () => {
  it('resolves dangling canonical links without manufacturing semantic edges', async () => {
    const capsuleRepo = {
      resolveCanonicalLinks: jest.fn().mockResolvedValue({
        resolvedLinkCount: 2,
      }),
      resolveCanonicalLinksAndMaterializeEdges: jest.fn().mockResolvedValue({
        resolvedLinkCount: 2,
        materializedEdgeCount: 5,
      }),
    };
    const service = new KnowledgeLinkResolverService(
      capsuleRepo as unknown as KnowledgeCapsuleRepo,
    );

    await expect(
      service.resolveSpace({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({ resolvedLinkCount: 2 });
    expect(capsuleRepo.resolveCanonicalLinks).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(
      capsuleRepo.resolveCanonicalLinksAndMaterializeEdges,
    ).not.toHaveBeenCalled();
  });
});
