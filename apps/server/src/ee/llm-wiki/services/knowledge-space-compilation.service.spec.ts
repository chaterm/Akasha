import { Queue } from 'bullmq';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeImageExtractionRepo } from '@akasha/db/repos/llm-wiki/knowledge-image-extraction.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import {
  KnowledgeSpaceExecutionRepo,
  SpaceExecutionLease,
} from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { QueueJob } from '../../../integrations/queue/constants';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../llm-wiki.constants';
import { buildEffectiveKnowledgeHash } from './knowledge-effective-hash';
import { KnowledgeSourceExporterService } from './knowledge-source-exporter.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';

describe('KnowledgeSpaceCompilationService', () => {
  it('dispatches a DB-reserved Space slice and never fans out page jobs', async () => {
    const fixture = createService({
      reservationCandidates: [{ id: 'run-space' }],
      undispatchedSpaceSlices: [spaceSlice()],
    });

    await fixture.service.dispatchPending();

    expect(fixture.repo.reserveNextSpaceSlice).toHaveBeenCalledWith({
      runId: 'run-space',
    });
    expect(fixture.spaceQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_SPACE_TEXT,
      expect.objectContaining({
        spaceRunId: 'run-space',
        phase: 'text',
        spaceJobSequence: 1,
      }),
      {
        jobId: 'knowledge-space-text__run-space__text__1',
        priority: 5,
      },
    );
    expect(fixture.repo.markSpaceSliceDispatched).toHaveBeenCalledWith(
      expect.objectContaining({ spaceJobId: spaceSlice().spaceJobId }),
    );
  });

  it('gives image merge slices priority over newly queued text slices', async () => {
    const fixture = createService({
      undispatchedSpaceSlices: [
        {
          ...spaceSlice(),
          runId: 'run-image-merge',
          jobPhase: 'image_merge',
          spaceJobSequence: 3,
          spaceJobId:
            'knowledge-space-image-merge__run-image-merge__image_merge__3',
        },
      ],
    });

    await fixture.service.dispatchPending();

    expect(fixture.spaceQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_MERGE_SPACE_IMAGES,
      expect.objectContaining({ phase: 'image_merge' }),
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('requests a queued run without exporter, catalog, image, or LLM planning', async () => {
    const fixture = createService();
    fixture.repo.requestRuns.mockResolvedValue([
      {
        disposition: 'created',
        run: { id: 'queued-run', status: 'queued', initializedAt: null },
      },
    ]);

    await expect(
      fixture.service.requestRuns([
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          trigger: 'manual_compile',
          scanRemovedSources: true,
        },
      ]),
    ).resolves.toEqual([expect.objectContaining({ disposition: 'created' })]);

    expect(fixture.repo.requestRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [expect.objectContaining({ spaceId: 'space-1' })],
      }),
    );
    expect(fixture.imageQueue.add).not.toHaveBeenCalled();
  });

  it('routes page updates through the shared durable Run arbitration', async () => {
    const fixture = createService();
    fixture.repo.requestIncrementalCompileForPages.mockResolvedValue([
      { disposition: 'coalesced', run: { id: 'run-1' } },
    ]);

    await expect(
      fixture.service.requestIncrementalCompileForPages({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual([{ disposition: 'coalesced', run: { id: 'run-1' } }]);
    expect(fixture.repo.requestIncrementalCompileForPages).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
        removed: false,
      }),
    );
  });

  it('makes a confirmed delayed page due and immediately runs the dispatcher', async () => {
    const fixture = createService();
    fixture.repo.markDelayedPageForImmediateCompilation.mockResolvedValue({
      scheduleId: 'schedule-1',
      sourcePageId: 'page-1',
      spaceId: 'space-1',
      pageName: 'Page 1',
    });

    await expect(
      fixture.service.requestImmediateDelayedPageCompilation({
        workspaceId: 'workspace-1',
        scheduleId: 'schedule-1',
        confirmationPageName: 'Page 1',
      }),
    ).resolves.toEqual(expect.objectContaining({ scheduleId: 'schedule-1' }));

    expect(
      fixture.repo.markDelayedPageForImmediateCompilation,
    ).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      scheduleId: 'schedule-1',
      confirmationPageName: 'Page 1',
    });
    expect(fixture.repo.promoteDuePageCompileSchedules).toHaveBeenCalled();
  });

  it('does not dispatch when delayed-page confirmation fails', async () => {
    const fixture = createService();
    fixture.repo.markDelayedPageForImmediateCompilation.mockResolvedValue(null);

    await fixture.service.requestImmediateDelayedPageCompilation({
      workspaceId: 'workspace-1',
      scheduleId: 'schedule-1',
      confirmationPageName: 'wrong',
    });

    expect(fixture.repo.promoteDuePageCompileSchedules).not.toHaveBeenCalled();
  });

  it('removes a confirmed page from the delayed queue without dispatching', async () => {
    const fixture = createService();
    fixture.repo.removeDelayedPageCompilation.mockResolvedValue({
      scheduleId: 'schedule-1',
      sourcePageId: 'page-1',
      spaceId: 'space-1',
      pageName: 'Page 1',
    });

    await expect(
      fixture.service.removeDelayedPageCompilation({
        workspaceId: 'workspace-1',
        scheduleId: 'schedule-1',
        confirmationPageName: 'Page 1',
      }),
    ).resolves.toEqual(expect.objectContaining({ scheduleId: 'schedule-1' }));

    expect(fixture.repo.removeDelayedPageCompilation).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      scheduleId: 'schedule-1',
      confirmationPageName: 'Page 1',
    });
    expect(fixture.repo.promoteDuePageCompileSchedules).not.toHaveBeenCalled();
  });

  it('initializes a full Space through metadata-only INSERT SELECT planning', async () => {
    const fixture = createService();

    await expect(fixture.service.initializeLeasedRun(lease())).resolves.toEqual(
      expect.objectContaining({ pageCompilationRequired: true }),
    );

    expect(fixture.executionRepo.initializeRun).toHaveBeenCalledWith(lease(), {
      targetSourcePageIds: null,
    });
    expect(fixture.sourceExporter.exportPageSources).not.toHaveBeenCalled();
    expect(
      fixture.imageExtractionRepo.findCurrentReadyForSnapshotImages,
    ).not.toHaveBeenCalled();
    expect(
      fixture.compilationRepo.findSpaceReuseCandidates,
    ).not.toHaveBeenCalled();
  });

  it('resumes an initialized Run without repeating whole-Space planning', async () => {
    const fixture = createService();
    fixture.executionRepo.findLeasedRun.mockResolvedValue({
      id: 'current-run',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      initializedAt: new Date('2026-08-03T00:00:00.000Z'),
      aggregateRequired: false,
      expectedPageCount: 1,
      succeededPageCount: 1,
      failedPageCount: 0,
      skippedPageCount: 0,
    });

    await expect(fixture.service.initializeLeasedRun(lease())).resolves.toEqual(
      expect.objectContaining({
        initialized: false,
        aggregateRequired: false,
        pageCompilationRequired: false,
      }),
    );

    expect(fixture.executionRepo.initializeRun).not.toHaveBeenCalled();
  });

  it('initializes a page-scoped Run without exporting target bodies', async () => {
    const fixture = createService({
      targetSourcePageIds: ['page-1'],
    });

    await fixture.service.initializeLeasedRun(lease());

    expect(fixture.executionRepo.initializeRun).toHaveBeenCalledWith(lease(), {
      targetSourcePageIds: ['page-1'],
    });
    expect(fixture.sourceExporter.exportPageSources).not.toHaveBeenCalled();
  });

  it('binds the latest single-page snapshot and moves image planning to the worker', async () => {
    const source = sourceSnapshotWithImages(2);
    const fixture = createService({
      exportedSources: [source],
      readyExtractions: [readyExtraction(source.images[0])],
    });

    await expect(
      fixture.service.bindLeasedRunPage(lease(), { sourcePageId: 'page-1' }),
    ).resolves.toEqual(expect.objectContaining({ outcome: 'bound' }));

    expect(fixture.sourceExporter.exportPageSources).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageIds: ['page-1'],
    });
    expect(fixture.executionRepo.bindTextPage).toHaveBeenCalledWith(
      lease(),
      expect.objectContaining({
        expectedSourceVersion: source.sourceVersion,
        expectedSourceContentHash: source.contentHash,
        expectedImageCount: 2,
        succeededImageCount: 1,
        imageStatus: 'pending',
        mergeStatus: 'waiting_images',
        images: [
          expect.objectContaining({ attachmentId: 'attachment-1' }),
          expect.objectContaining({ attachmentId: 'attachment-2' }),
        ],
      }),
    );
  });

  it('reuses an unchanged bound snapshot without image planning or model identity checks', async () => {
    const previous = sourceSnapshot();
    const current = { ...previous, sourceVersion: 'v2' };
    const fixture = createService({
      exportedSources: [current],
      reuseCandidates: [
        {
          ...reuseCandidate(previous),
          contributionCompilerVersion: 'old-compiler',
          contributionPromptVersion: 'old-prompt',
        },
      ],
    });

    await expect(
      fixture.service.bindLeasedRunPage(lease(), { sourcePageId: 'page-1' }),
    ).resolves.toEqual(expect.objectContaining({ outcome: 'reused' }));

    expect(fixture.sourceExporter.exportPageSources).toHaveBeenCalledTimes(1);
    expect(fixture.executionRepo.bindTextPage).toHaveBeenCalledWith(
      lease(),
      expect.objectContaining({
        expectedSourceVersion: 'v2',
        reused: true,
        images: [],
      }),
    );
    expect(
      fixture.imageExtractionRepo.findCurrentReadyForSnapshotImages,
    ).not.toHaveBeenCalled();
  });

  it('bypasses reuse for a force rebuild', async () => {
    const source = sourceSnapshot();
    const fixture = createService({
      exportedSources: [source],
      reuseCandidates: [reuseCandidate(source)],
      mode: 'force_rebuild',
    });

    await expect(
      fixture.service.bindLeasedRunPage(lease(), { sourcePageId: 'page-1' }),
    ).resolves.toEqual(expect.objectContaining({ outcome: 'bound' }));
    expect(fixture.executionRepo.bindTextPage).toHaveBeenCalledWith(
      lease(),
      expect.not.objectContaining({ reused: true }),
    );
  });

  it.each(['page_retry', 'follow_up'])(
    'bypasses reuse for a %s run so degraded output can self-heal',
    async (trigger) => {
      const source = sourceSnapshot();
      const fixture = createService({
        exportedSources: [source],
        reuseCandidates: [reuseCandidate(source)],
        trigger,
      });

      await expect(
        fixture.service.bindLeasedRunPage(lease(), {
          sourcePageId: 'page-1',
        }),
      ).resolves.toEqual(expect.objectContaining({ outcome: 'bound' }));
      expect(fixture.executionRepo.bindTextPage).toHaveBeenCalledWith(
        lease(),
        expect.not.objectContaining({ reused: true }),
      );
    },
  );

  it('binds only the first 50 images and records overflow as partial quality', async () => {
    const source = sourceSnapshotWithImages(60);
    const fixture = createService({
      exportedSources: [source],
      reuseCandidates: [reuseCandidate(source)],
      readyExtractions: source.images.slice(0, 50).map(readyExtraction),
    });

    await fixture.service.bindLeasedRunPage(lease(), {
      sourcePageId: 'page-1',
    });

    const plan = fixture.executionRepo.bindTextPage.mock.calls[0][1];
    expect(plan).toEqual(
      expect.objectContaining({
        expectedImageCount: 60,
        succeededImageCount: 50,
        skippedImageCount: 10,
        imageStatus: 'partial',
        mergeStatus: 'pending',
        qualityStatus: 'partial_image',
      }),
    );
    expect(plan.images).toHaveLength(50);
    expect(plan.images.map((image) => image.imageOrdinal)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );
  });

  it('terminalizes a page deleted before binding without retrying compilation', async () => {
    const fixture = createService({ exportedSources: [] });

    await expect(
      fixture.service.bindLeasedRunPage(lease(), { sourcePageId: 'page-1' }),
    ).resolves.toEqual({ outcome: 'terminalized' });
    expect(
      fixture.executionRepo.terminalizeUnboundTextPage,
    ).toHaveBeenCalledWith(
      lease(),
      expect.objectContaining({
        sourcePageId: 'page-1',
        errorCode: 'source_unavailable',
      }),
    );
  });
});

function createService(
  overrides: {
    reservationCandidates?: unknown[];
    undispatchedSpaceSlices?: unknown[];
    exportedSources?: ReturnType<typeof sourceSnapshot>[];
    reuseCandidates?: unknown[];
    readyExtractions?: unknown[];
    targetSourcePageIds?: string[] | null;
    trigger?: string;
    mode?: string;
  } = {},
) {
  const repo = {
    requestRuns: jest.fn().mockResolvedValue([]),
    requestIncrementalCompileForPages: jest.fn().mockResolvedValue([]),
    markDelayedPageForImmediateCompilation: jest.fn(),
    removeDelayedPageCompilation: jest.fn(),
    promoteDuePageCompileSchedules: jest.fn().mockResolvedValue({
      selectedPageCount: 0,
      promotedPageCount: 0,
      runRequestCount: 0,
    }),
    findSpaceSliceReservationCandidates: jest
      .fn()
      .mockResolvedValue(overrides.reservationCandidates ?? []),
    reserveNextSpaceSlice: jest.fn().mockResolvedValue(undefined),
    findUndispatchedSpaceSlices: jest
      .fn()
      .mockResolvedValue(overrides.undispatchedSpaceSlices ?? []),
    markSpaceSliceDispatched: jest.fn().mockResolvedValue(true),
    reserveRunImagesFairly: jest.fn().mockResolvedValue([]),
    findUndispatchedRunImages: jest.fn().mockResolvedValue([]),
    markRunImageDispatched: jest.fn().mockResolvedValue(true),
  };
  const spaceQueue = { add: jest.fn(), getJob: jest.fn() };
  const imageQueue = { add: jest.fn(), getJob: jest.fn() };
  const compilationRepo = {
    findSpaceReuseCandidates: jest
      .fn()
      .mockResolvedValue(overrides.reuseCandidates ?? []),
  };
  const imageExtractionRepo = {
    findCurrentReadyForSnapshotImages: jest
      .fn()
      .mockResolvedValue(overrides.readyExtractions ?? []),
  };
  const sourceExporter = {
    exportPageSources: jest
      .fn()
      .mockResolvedValue(overrides.exportedSources ?? []),
  };
  const executionRepo = {
    findLeasedRun: jest.fn().mockResolvedValue({
      id: 'current-run',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      targetSourcePageIds: overrides.targetSourcePageIds ?? null,
      trigger: overrides.trigger ?? 'page_update',
      mode: overrides.mode ?? 'incremental',
      expectedPageCount: 1,
      succeededPageCount: 0,
      failedPageCount: 0,
      skippedPageCount: 0,
      aggregateRequired: true,
    }),
    initializeRun: jest.fn().mockResolvedValue({
      initialized: true,
      run: {
        id: 'current-run',
        expectedPageCount: 1,
        succeededPageCount: 0,
        failedPageCount: 0,
        skippedPageCount: 0,
        aggregateRequired: true,
      },
    }),
    bindTextPage: jest.fn().mockImplementation((_lease, input) =>
      Promise.resolve({
        id: 'run-page-1',
        bindingStatus: 'bound',
        ...input,
      }),
    ),
    terminalizeUnboundTextPage: jest
      .fn()
      .mockResolvedValue({ terminalized: true }),
  };
  const environmentService = {
    getAiVisionModel: jest.fn().mockReturnValue('vision-model'),
  };
  const service = new KnowledgeSpaceCompilationService(
    spaceQueue as unknown as Queue,
    imageQueue as unknown as Queue,
    repo as unknown as KnowledgeSpaceCompilationRepo,
    compilationRepo as unknown as KnowledgeCompilationRepo,
    imageExtractionRepo as unknown as KnowledgeImageExtractionRepo,
    environmentService as unknown as EnvironmentService,
    sourceExporter as unknown as KnowledgeSourceExporterService,
    executionRepo as unknown as KnowledgeSpaceExecutionRepo,
  );
  return {
    service,
    repo,
    spaceQueue,
    imageQueue,
    sourceExporter,
    executionRepo,
    compilationRepo,
    imageExtractionRepo,
  };
}

function lease(): SpaceExecutionLease {
  return {
    runId: 'current-run',
    knowledgeGeneration: 4,
    jobPhase: 'text',
    spaceJobSequence: 1,
    spaceJobId: 'knowledge-space-text__current-run__text__1',
    executionToken: 'execution-token',
  };
}

function spaceSlice() {
  return {
    runId: 'run-space',
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    knowledgeGeneration: 4,
    jobPhase: 'text',
    spaceJobSequence: 1,
    spaceJobId: 'knowledge-space-text__run-space__text__1',
  };
}

function sourceSnapshot() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'sha256:page-1',
    title: 'Page one',
    text: 'Body',
    images: [],
    references: [],
  };
}

function sourceSnapshotWithImages(count: number) {
  return {
    ...sourceSnapshot(),
    images: Array.from({ length: count }, (_, index) => ({
      attachmentId: `attachment-${index + 1}`,
      fileName: `image-${index + 1}.png`,
      mimeType: 'image/png' as const,
      fileSize: 100,
      attachmentVersion: new Date(index + 1).toISOString(),
      altText: `Image ${index + 1}`,
    })),
  };
}

function readyExtraction(
  image: ReturnType<typeof sourceSnapshotWithImages>['images'][number],
) {
  const attachmentVersion = new Date(image.attachmentVersion);
  return {
    id: `extraction-${image.attachmentId}`,
    workspaceId: 'workspace-1',
    attachmentId: image.attachmentId,
    attachmentWorkspaceId: 'workspace-1',
    attachmentSpaceId: 'space-1',
    attachmentPageId: 'page-1',
    attachmentVersion,
    currentAttachmentVersion: attachmentVersion,
    status: 'ready',
    model: 'vision-model',
    promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
    cacheFingerprint: `cache-${image.attachmentId}`,
    contentHash: `sha256:${image.attachmentId}`,
    ocrText: `Text ${image.attachmentId}`,
    caption: '',
  };
}

function reuseCandidate(source: ReturnType<typeof sourceSnapshot>) {
  return {
    sourcePageId: source.sourcePageId,
    activeSourceId: 'source-1',
    activeSummaryId: 'summary-1',
    activeSummaryChunkId: 'summary-chunk-1',
    lastSuccessfulSourceVersion: source.sourceVersion,
    lastSuccessfulSourceHash: source.contentHash,
    contributionSourceVersion: source.sourceVersion,
    contributionSourceHash: source.contentHash,
    contributionCompilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
    contributionPromptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
    lastSuccessfulEffectiveHash: buildEffectiveKnowledgeHash({
      sourceContentHash: source.contentHash,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      readyImages: [],
    }),
  };
}
