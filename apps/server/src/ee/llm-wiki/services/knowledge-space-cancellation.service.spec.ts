import { NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';

describe('KnowledgeSpaceCompilationService cancellation', () => {
  it('commits the database fence before removing exact non-active jobs', async () => {
    const activeJob = {
      getState: jest.fn().mockResolvedValue('active'),
      remove: jest.fn(),
    };
    const waitingJob = {
      getState: jest.fn().mockResolvedValue('waiting'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const fixture = createFixture({
      disposition: 'cancelled',
      previousStatus: 'compiling',
      previousPhase: 'images',
      run: {
        id: 'run-1',
        spaceId: 'space-1',
        status: 'cancelled',
        phase: 'complete',
      },
      jobIds: ['space-active', 'image-waiting', 'already-missing'],
    });
    fixture.spaceQueue.getJob.mockImplementation(async (jobId: string) =>
      jobId === 'space-active' ? activeJob : undefined,
    );
    fixture.imageQueue.getJob.mockImplementation(async (jobId: string) =>
      jobId === 'image-waiting' ? waitingJob : undefined,
    );

    await expect(
      fixture.service.cancelRun({
        workspaceId: 'workspace-1',
        runId: 'run-1',
        reason: 'Operator stopped the test.',
      }),
    ).resolves.toEqual({
      disposition: 'cancelled',
      runId: 'run-1',
      spaceId: 'space-1',
      status: 'cancelled',
      phase: 'complete',
      previousStatus: 'compiling',
      previousPhase: 'images',
      removedJobCount: 1,
      fencedActiveJobCount: 1,
      cleanupErrorCount: 0,
    });
    expect(fixture.repo.cancelRun).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      runId: 'run-1',
      reason: 'Operator stopped the test.',
    });
    expect(activeJob.remove).not.toHaveBeenCalled();
    expect(waitingJob.remove).toHaveBeenCalledTimes(1);
    expect(fixture.repo.cancelRun.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.spaceQueue.getJob.mock.invocationCallOrder[0],
    );
  });

  it('is idempotent after a Run is already terminal', async () => {
    const fixture = createFixture({
      disposition: 'already_terminal',
      run: {
        id: 'run-1',
        spaceId: 'space-1',
        status: 'cancelled',
        phase: 'complete',
      },
      jobIds: [],
    });

    await expect(
      fixture.service.cancelRun({
        workspaceId: 'workspace-1',
        runId: 'run-1',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        disposition: 'already_terminal',
        status: 'cancelled',
        removedJobCount: 0,
      }),
    );
    expect(fixture.spaceQueue.getJob).not.toHaveBeenCalled();
    expect(fixture.imageQueue.getJob).not.toHaveBeenCalled();
  });

  it('does not touch Redis when the workspace-scoped Run is absent', async () => {
    const fixture = createFixture({ disposition: 'not_found' });

    await expect(
      fixture.service.cancelRun({
        workspaceId: 'workspace-1',
        runId: 'missing-run',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(fixture.spaceQueue.getJob).not.toHaveBeenCalled();
    expect(fixture.imageQueue.getJob).not.toHaveBeenCalled();
  });
});

function createFixture(cancelResult: object) {
  const spaceQueue = { getJob: jest.fn(), add: jest.fn() };
  const imageQueue = { getJob: jest.fn(), add: jest.fn() };
  const repo = {
    cancelRun: jest.fn().mockResolvedValue(cancelResult),
  };
  const service = new KnowledgeSpaceCompilationService(
    spaceQueue as unknown as Queue,
    imageQueue as unknown as Queue,
    repo as unknown as KnowledgeSpaceCompilationRepo,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  return { service, repo, spaceQueue, imageQueue };
}
