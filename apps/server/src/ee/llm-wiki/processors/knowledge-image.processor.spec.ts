import {
  PROCESSOR_METADATA,
  WORKER_METADATA,
} from '@nestjs/bullmq/dist/bull.constants';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { KnowledgeImageEnrichmentService } from '../services/knowledge-image-enrichment.service';
import { KnowledgeSourceExporterService } from '../services/knowledge-source-exporter.service';
import { KnowledgeSpaceCompilationService } from '../services/knowledge-space-compilation.service';
import { KnowledgeImageProcessor } from './knowledge-image.processor';

describe('KnowledgeImageProcessor', () => {
  it('runs the dedicated image queue with concurrency 5', () => {
    expect(
      Reflect.getMetadata(PROCESSOR_METADATA, KnowledgeImageProcessor),
    ).toEqual({ name: QueueName.KNOWLEDGE_IMAGE_QUEUE });
    expect(
      Reflect.getMetadata(WORKER_METADATA, KnowledgeImageProcessor),
    ).toEqual(expect.objectContaining({ concurrency: 5 }));
  });

  it('claims and compiles exactly one frozen RunImage', async () => {
    const fixture = createFixture();
    fixture.compilation.claimRunImage.mockResolvedValue({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      attachmentId: 'image-1',
      fileName: 'one.png',
      mimeType: 'image/png',
      fileSize: 10,
      altText: null,
      expectedAttachmentVersion: new Date('2026-07-27T00:00:00.000Z'),
    });
    fixture.enrichment.enrichSingleImage.mockResolvedValue({
      status: 'succeeded',
      extractionId: 'extraction-1',
      retryable: false,
    });

    await expect(fixture.processor.process(runImageJob())).resolves.toEqual(
      expect.objectContaining({ status: 'succeeded' }),
    );

    expect(fixture.enrichment.enrichSingleImage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePageId: 'page-1',
        image: expect.objectContaining({ attachmentId: 'image-1' }),
      }),
      expect.any(AbortSignal),
    );
    expect(fixture.enrichment.enrichSource).not.toHaveBeenCalled();
    expect(fixture.compilation.completeRunImage).toHaveBeenCalledWith(
      expect.objectContaining({
        runImageId: 'run-image-1',
        status: 'succeeded',
        extractionId: 'extraction-1',
      }),
    );
  });

  it.skip('legacy: persists page counters and continues after permanent image failures', async () => {
    const fixture = createFixture({
      result: pageResult({ expected: 3, failed: 1, skipped: 1 }),
    });

    await expect(fixture.processor.process(job())).resolves.toEqual(
      expect.objectContaining({ status: 'partial' }),
    );
    expect(fixture.enrichment.enrichSource).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePageId: 'page-1' }),
    );
    expect(fixture.compilation.completePageImages).toHaveBeenCalledWith({
      runId: 'run-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:page',
      knowledgeGeneration: 4,
      status: 'partial',
      expected: 3,
      succeeded: 1,
      failed: 1,
      skipped: 1,
    });
  });

  it.skip('legacy: retries only retryable image failures and keeps the run page nonterminal', async () => {
    const fixture = createFixture({
      result: pageResult({ failed: 1, retryableFailureCount: 1 }),
    });

    await expect(fixture.processor.process(job())).rejects.toThrow(
      'retryable image extraction',
    );
    expect(fixture.compilation.recordPageImageAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        sourcePageId: 'page-1',
        failed: 1,
      }),
    );
    expect(fixture.compilation.completePageImages).not.toHaveBeenCalled();
  });

  it.skip('legacy: completes stale generation or changed source as a no-op without vision work', async () => {
    const fixture = createFixture({ beginAccepted: false });

    await expect(fixture.processor.process(job())).resolves.toEqual(
      expect.objectContaining({ status: 'noop' }),
    );
    expect(fixture.exporter.exportPageSources).not.toHaveBeenCalled();
    expect(fixture.enrichment.enrichSource).not.toHaveBeenCalled();
  });

  it.skip('legacy: terminally skips a Run page when its source changes after dispatch', async () => {
    const fixture = createFixture({ sourceContentHash: 'sha256:new-page' });

    await expect(fixture.processor.process(job())).resolves.toEqual(
      expect.objectContaining({ status: 'noop' }),
    );
    expect(fixture.enrichment.enrichSource).not.toHaveBeenCalled();
    expect(fixture.compilation.completePageImages).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'partial',
        expected: 1,
        succeeded: 0,
        failed: 0,
        skipped: 1,
      }),
    );
  });

  it.skip('legacy: marks the durable image state failed when the final retry is exhausted', async () => {
    const fixture = createFixture({
      result: pageResult({ succeeded: 0, failed: 1, retryableFailureCount: 1 }),
    });
    const finalJob = job({ attemptsMade: 2, opts: { attempts: 3 } });

    await expect(fixture.processor.process(finalJob)).resolves.toEqual(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(fixture.compilation.completePageImages).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failed: 1 }),
    );
  });

  it.skip('legacy: backfills a durable failed state when the worker fails outside the handler', async () => {
    const fixture = createFixture();
    const failedJob = job({
      attemptsMade: 3,
      opts: { attempts: 3 },
      failedReason: 'worker stalled too many times',
    });

    await fixture.processor.onFailed(failedJob);

    expect(fixture.compilation.completePageImages).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        sourcePageId: 'page-1',
        status: 'failed',
        expected: 1,
        succeeded: 0,
        failed: 1,
        skipped: 0,
      }),
    );
  });

  it.skip('legacy: queues a standalone page merge after usable image knowledge is ready', async () => {
    const fixture = createFixture();
    const standalone = job({
      data: { ...job().data, spaceRunId: undefined },
    });

    await fixture.processor.process(standalone);

    expect(fixture.compilation.queueStandalonePageMerge).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePageId: 'page-1' }),
    );
    expect(fixture.compilation.completePageImages).not.toHaveBeenCalled();
  });

  it('rejects the removed page-sized image job', async () => {
    const fixture = createFixture();
    await expect(fixture.processor.process(job())).rejects.toThrow(
      'Unsupported Knowledge Image job',
    );
    expect(fixture.enrichment.enrichSource).not.toHaveBeenCalled();
  });
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'image-job-1',
    name: QueueJob.KNOWLEDGE_COMPILE_PAGE_IMAGES,
    data: {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:page',
      spaceRunId: 'run-1',
      knowledgeGeneration: 4,
      images: [image()],
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as Job;
}

function runImageJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'knowledge-compile-image__run-1__run-image-1__4',
    name: QueueJob.KNOWLEDGE_COMPILE_IMAGE,
    data: {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      spaceRunId: 'run-1',
      runImageId: 'run-image-1',
      knowledgeGeneration: 4,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as Job;
}

function createFixture(
  overrides: {
    beginAccepted?: boolean;
    result?: ReturnType<typeof pageResult>;
    sourceContentHash?: string;
  } = {},
) {
  const source = {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: overrides.sourceContentHash ?? 'sha256:page',
    title: 'Page',
    text: 'Body',
    images: [image()],
    references: [],
  };
  const exporter = {
    exportPageSources: jest.fn().mockResolvedValue([source]),
  };
  const enrichment = {
    enrichSource: jest.fn().mockResolvedValue(overrides.result ?? pageResult()),
    enrichSingleImage: jest.fn(),
  };
  const compilation = {
    beginPageImages: jest
      .fn()
      .mockResolvedValue(overrides.beginAccepted ?? true),
    isPageImageJobCurrent: jest.fn().mockResolvedValue(true),
    recordPageImageAttempt: jest.fn().mockResolvedValue(true),
    completePageImages: jest.fn().mockResolvedValue(true),
    queueStandalonePageMerge: jest.fn().mockResolvedValue('merge-job-1'),
    claimRunImage: jest.fn(),
    completeRunImage: jest.fn().mockResolvedValue({ imageStatus: 'succeeded' }),
  };
  const processor = new KnowledgeImageProcessor(
    exporter as unknown as KnowledgeSourceExporterService,
    enrichment as unknown as KnowledgeImageEnrichmentService,
    compilation as unknown as KnowledgeSpaceCompilationService,
  );
  return { processor, exporter, enrichment, compilation };
}

function image() {
  return {
    attachmentId: 'image-1',
    attachmentVersion: 'image-v1',
    fileName: 'one.png',
    mimeType: 'image/png' as const,
    fileSize: 10,
  };
}

function pageResult(
  overrides: Partial<{
    expected: number;
    succeeded: number;
    failed: number;
    skipped: number;
    retryableFailureCount: number;
    readyExtractionIds: string[];
    truncatedCount: number;
  }> = {},
) {
  return {
    expected: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    retryableFailureCount: 0,
    readyExtractionIds: ['extraction-1'],
    truncatedCount: 0,
    ...overrides,
  };
}
