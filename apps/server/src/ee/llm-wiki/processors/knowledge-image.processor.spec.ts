import {
  PROCESSOR_METADATA,
  WORKER_METADATA,
} from '@nestjs/bullmq/dist/bull.constants';
import { Job } from 'bullmq';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { KnowledgeImageEnrichmentService } from '../services/knowledge-image-enrichment.service';
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
    expect(fixture.compilation.completeRunImage).toHaveBeenCalledWith(
      expect.objectContaining({
        runImageId: 'run-image-1',
        status: 'succeeded',
        extractionId: 'extraction-1',
      }),
    );
  });

  it('rejects the removed page-sized image job', async () => {
    const fixture = createFixture();

    await expect(
      fixture.processor.process({
        name: 'knowledge-compile-page-images',
      } as Job),
    ).rejects.toThrow('Unsupported Knowledge Image job');
    expect(fixture.enrichment.enrichSingleImage).not.toHaveBeenCalled();
  });
});

function runImageJob(): Job {
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
  } as Job;
}

function createFixture() {
  const enrichment = {
    enrichSingleImage: jest.fn(),
  };
  const compilation = {
    claimRunImage: jest.fn(),
    completeRunImage: jest.fn().mockResolvedValue(true),
  };
  const processor = new KnowledgeImageProcessor(
    enrichment as unknown as KnowledgeImageEnrichmentService,
    compilation as unknown as KnowledgeSpaceCompilationService,
  );
  return { processor, enrichment, compilation };
}
