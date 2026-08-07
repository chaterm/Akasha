import { KnowledgeSpaceFinalizerService } from './knowledge-space-finalizer.service';

describe('KnowledgeSpaceFinalizerService', () => {
  it('resolves canonical links once without LLM, embedding, or Catalog work', async () => {
    const executionRepo = {
      isLeaseActive: jest.fn().mockResolvedValue(true),
    };
    const linkResolver = {
      resolveSpace: jest.fn().mockResolvedValue({ resolvedLinkCount: 3 }),
    };
    const service = new KnowledgeSpaceFinalizerService(
      executionRepo as never,
      linkResolver as never,
    );
    const abortController = new AbortController();

    await expect(
      service.finalizeLeased(lease(), {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        abortSignal: abortController.signal,
      }),
    ).resolves.toEqual({
      outcome: 'completed',
      resolvedCanonicalLinkCount: 3,
    });

    expect(linkResolver.resolveSpace).toHaveBeenCalledTimes(1);
    expect(linkResolver.resolveSpace).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      abortSignal: abortController.signal,
    });
    expect(executionRepo.isLeaseActive).toHaveBeenCalledTimes(2);
  });

  it('does no work when the lease is already superseded', async () => {
    const executionRepo = {
      isLeaseActive: jest.fn().mockResolvedValue(false),
    };
    const linkResolver = { resolveSpace: jest.fn() };
    const service = new KnowledgeSpaceFinalizerService(
      executionRepo as never,
      linkResolver as never,
    );

    await expect(
      service.finalizeLeased(lease(), {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      outcome: 'superseded',
      resolvedCanonicalLinkCount: 0,
    });
    expect(linkResolver.resolveSpace).not.toHaveBeenCalled();
  });

  it('does not let a worker complete the Run when its lease is lost during resolution', async () => {
    const executionRepo = {
      isLeaseActive: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };
    const linkResolver = {
      resolveSpace: jest.fn().mockResolvedValue({ resolvedLinkCount: 1 }),
    };
    const service = new KnowledgeSpaceFinalizerService(
      executionRepo as never,
      linkResolver as never,
    );

    await expect(
      service.finalizeLeased(lease(), {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toEqual({
      outcome: 'superseded',
      resolvedCanonicalLinkCount: 0,
    });
    expect(linkResolver.resolveSpace).toHaveBeenCalledTimes(1);
  });
});

function lease() {
  return {
    runId: 'run-1',
    knowledgeGeneration: 2,
    jobPhase: 'text' as const,
    spaceJobSequence: 3,
    spaceJobId: 'job-3',
    executionToken: 'lease-token',
  };
}
