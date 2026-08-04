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
});
