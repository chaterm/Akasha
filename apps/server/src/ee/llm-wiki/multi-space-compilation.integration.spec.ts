import { QueueJob } from '../../integrations/queue/constants';
import { buildWorkerCapacityEstimate } from './services/knowledge-diagnostics.service';
import { KnowledgeSpaceCompilationService } from './services/knowledge-space-compilation.service';
import {
  KNOWLEDGE_IMAGE_WORKER_OPTIONS,
  KNOWLEDGE_SPACE_WORKER_OPTIONS,
  KNOWLEDGE_WORKER_SETTINGS,
} from './services/knowledge-worker-settings';

describe('multi-Space compilation architecture', () => {
  it('turns a 100-Space request into 100 durable Space slices without page-job fan-out', async () => {
    const runRepo = createRunRepo();
    const requests = Array.from({ length: 100 }, (_, index) => ({
      workspaceId: 'workspace-1',
      spaceId: `space-${index + 1}`,
      trigger: 'manual_compile',
    }));
    const slices = requests.map((request, index) => ({
      runId: `run-${index + 1}`,
      workspaceId: request.workspaceId,
      spaceId: request.spaceId,
      knowledgeGeneration: 1,
      jobPhase: 'text' as const,
      spaceJobSequence: 1,
      spaceJobId: `knowledge-space-text__run-${index + 1}__text__1`,
      spaceJobQueuedAt: new Date(index),
    }));
    runRepo.requestRuns.mockResolvedValue(
      requests.map((request, index) => ({
        disposition: 'created',
        run: { id: `run-${index + 1}`, spaceId: request.spaceId },
      })),
    );
    runRepo.findSpaceSliceReservationCandidates.mockResolvedValue(
      slices.map((slice) => ({
        id: slice.runId,
        workspaceId: slice.workspaceId,
        spaceId: slice.spaceId,
        phase: slice.jobPhase,
        spaceJobQueuedAt: slice.spaceJobQueuedAt,
      })),
    );
    runRepo.findUndispatchedSpaceSlices.mockResolvedValue(slices);
    const { service, spaceQueue, imageQueue } = createService(runRepo);

    await expect(service.requestRuns(requests)).resolves.toHaveLength(100);

    expect(runRepo.requestRuns.mock.calls[0][0].requests).toHaveLength(100);
    expect(runRepo.reserveNextSpaceSlice).toHaveBeenCalledTimes(100);
    expect(spaceQueue.add).toHaveBeenCalledTimes(100);
    expect(
      spaceQueue.add.mock.calls.every(
        ([name, payload, options]) =>
          name === QueueJob.KNOWLEDGE_COMPILE_SPACE_TEXT &&
          payload.sourcePageIds === undefined &&
          options.priority === 5,
      ),
    ).toBe(true);
    expect(imageQueue.add).not.toHaveBeenCalled();
  });

  it('shares single-image jobs across Spaces and keeps snapshot data out of Redis', async () => {
    const runRepo = createRunRepo();
    runRepo.findUndispatchedRunImages.mockResolvedValue([
      runImage('space-1', 'run-1', 'run-image-1'),
      runImage('space-2', 'run-2', 'run-image-2'),
    ]);
    const { service, imageQueue } = createService(runRepo);

    await service.dispatchPending();

    expect(runRepo.reserveRunImagesFairly).toHaveBeenCalledWith({
      maxOutstandingPerRun: 5,
      runLimit: 100,
    });
    expect(imageQueue.add).toHaveBeenCalledTimes(2);
    for (const [name, payload, options] of imageQueue.add.mock.calls) {
      expect(name).toBe(QueueJob.KNOWLEDGE_COMPILE_IMAGE);
      expect(Object.keys(payload).sort()).toEqual([
        'knowledgeGeneration',
        'runImageId',
        'spaceId',
        'spaceRunId',
        'workspaceId',
      ]);
      expect(JSON.stringify(payload)).not.toContain('sourceContentHash');
      expect(options).toMatchObject({ attempts: 3 });
    }
  });

  it('scales estimated capacity with replicas while keeping PostgreSQL authoritative', () => {
    expect(KNOWLEDGE_SPACE_WORKER_OPTIONS.concurrency).toBe(10);
    expect(KNOWLEDGE_IMAGE_WORKER_OPTIONS.concurrency).toBe(5);
    expect(KNOWLEDGE_WORKER_SETTINGS.databaseMaxPool).toBeGreaterThanOrEqual(
      KNOWLEDGE_SPACE_WORKER_OPTIONS.concurrency +
        KNOWLEDGE_IMAGE_WORKER_OPTIONS.concurrency +
        10,
    );
    expect(
      buildWorkerCapacityEstimate(
        Array.from({ length: 3 }, (_, index) => ({
          name: `space-worker-${index + 1}`,
        })),
        KNOWLEDGE_SPACE_WORKER_OPTIONS.concurrency,
      ),
    ).toEqual({
      workerCount: 3,
      capacity: 30,
      exact: false,
      source: 'bullmq_client_list',
    });
    expect(
      buildWorkerCapacityEstimate(
        Array.from({ length: 4 }, (_, index) => ({
          name: `space-worker-${index + 1}`,
        })),
        KNOWLEDGE_SPACE_WORKER_OPTIONS.concurrency,
      ).capacity,
    ).toBe(40);
    expect(
      buildWorkerCapacityEstimate(
        [{ name: 'GCP does not support client list' }],
        KNOWLEDGE_SPACE_WORKER_OPTIONS.concurrency,
      ).capacity,
    ).toBeNull();
  });
});

function createService(runRepo: ReturnType<typeof createRunRepo>) {
  const spaceQueue = { add: jest.fn() };
  const imageQueue = { add: jest.fn() };
  const service = new KnowledgeSpaceCompilationService(
    spaceQueue as never,
    imageQueue as never,
    runRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, spaceQueue, imageQueue };
}

function createRunRepo() {
  return {
    requestRuns: jest.fn().mockResolvedValue([]),
    findSpaceSliceReservationCandidates: jest.fn().mockResolvedValue([]),
    reserveNextSpaceSlice: jest.fn().mockResolvedValue(true),
    findUndispatchedSpaceSlices: jest.fn().mockResolvedValue([]),
    markSpaceSliceDispatched: jest.fn().mockResolvedValue(true),
    reserveRunImagesFairly: jest.fn().mockResolvedValue([]),
    findUndispatchedRunImages: jest.fn().mockResolvedValue([]),
    markRunImageDispatched: jest.fn().mockResolvedValue(true),
  };
}

function runImage(spaceId: string, runId: string, runImageId: string) {
  return {
    workspaceId: 'workspace-1',
    spaceId,
    runId,
    runImageId,
    knowledgeGeneration: 1,
    jobId: `knowledge-compile-image__${runId}__${runImageId}__1`,
  };
}
