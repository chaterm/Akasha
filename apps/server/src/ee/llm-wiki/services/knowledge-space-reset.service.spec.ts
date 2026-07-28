import { ConflictException, NotFoundException } from '@nestjs/common';
import { QueueName } from '../../../integrations/queue/constants';
import { KnowledgeSpaceResetService } from './knowledge-space-reset.service';

describe('KnowledgeSpaceResetService', () => {
  it('removes only returned removable jobs after commit and then dispatches the new run', async () => {
    const removable = {
      getState: jest.fn().mockResolvedValue('waiting'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const active = {
      getState: jest.fn().mockResolvedValue('active'),
      remove: jest.fn(),
    };
    const queue = {
      getJob: jest
        .fn()
        .mockResolvedValueOnce(removable)
        .mockResolvedValueOnce(active),
    };
    const imageQueue = {
      getJob: jest.fn().mockResolvedValue(undefined),
    };
    const runRepo = {
      forceResetAndCreateRun: jest.fn().mockResolvedValue({
        reset: true,
        generation: 8,
        run: { id: 'force-run', mode: 'force_rebuild' },
        supersededJobIds: ['waiting-job', 'active-job'],
      }),
    };
    const compilation = { dispatchPending: jest.fn() };
    const service = new KnowledgeSpaceResetService(
      queue as never,
      imageQueue as never,
      runRepo as never,
      compilation as never,
    );

    await expect(
      service.forceRebuild({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        confirmationSpaceName: 'Exact Space',
        sources: [
          {
            workspaceId: 'workspace-1',
            spaceId: 'space-1',
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            contentHash: 'sha256:page',
            title: 'Page',
            text: 'content',
            references: [],
            images: [{ attachmentId: 'attachment-1' }] as never,
          },
        ],
      }),
    ).resolves.toEqual({
      generation: 8,
      run: { id: 'force-run', mode: 'force_rebuild' },
    });

    expect(runRepo.forceResetAndCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationSpaceName: 'Exact Space',
        catalogSnapshot: [],
        catalogHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        sources: [
          expect.objectContaining({
            sourcePageId: 'page-1',
            expectedImageCount: 1,
          }),
        ],
      }),
    );
    expect(queue.getJob).toHaveBeenCalledTimes(2);
    expect(imageQueue.getJob).toHaveBeenCalledTimes(2);
    expect(removable.remove).toHaveBeenCalledTimes(1);
    expect(active.remove).not.toHaveBeenCalled();
    expect(compilation.dispatchPending).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['space_name_mismatch', ConflictException],
    ['space_not_found', NotFoundException],
  ])('rejects %s without Redis or dispatch', async (reason, errorType) => {
    const queue = { getJob: jest.fn() };
    const runRepo = {
      forceResetAndCreateRun: jest.fn().mockResolvedValue({
        reset: false,
        reason,
      }),
    };
    const compilation = { dispatchPending: jest.fn() };
    const service = new KnowledgeSpaceResetService(
      queue as never,
      { getJob: jest.fn() } as never,
      runRepo as never,
      compilation as never,
    );

    await expect(
      service.forceRebuild({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        confirmationSpaceName: 'Wrong',
        sources: [],
      }),
    ).rejects.toBeInstanceOf(errorType);
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(compilation.dispatchPending).not.toHaveBeenCalled();
  });
});
