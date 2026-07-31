import { Queue } from 'bullmq';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { KnowledgeArtifactContributionRepo } from '@akasha/db/repos/llm-wiki/knowledge-artifact-contribution.repo';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeImageExtractionRepo } from '@akasha/db/repos/llm-wiki/knowledge-image-extraction.repo';
import { KnowledgeSourceRepo } from '@akasha/db/repos/llm-wiki/knowledge-source.repo';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import { QueueJob } from '../../../integrations/queue/constants';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import {
  DEFAULT_KNOWLEDGE_COMPILER_VERSION,
  DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
  DEFAULT_KNOWLEDGE_PROMPT_VERSION,
} from '../llm-wiki.constants';
import { buildEffectiveKnowledgeHash } from './knowledge-effective-hash';
import { KnowledgeArtifactCatalogService } from './knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from './knowledge-space-compilation.service';

describe('KnowledgeSpaceCompilationService', () => {
  it('dispatches a DB-reserved Space slice and never fans out page jobs', async () => {
    const { service, repo, queue, spaceQueue } = createService({
      enableSpaceQueue: true,
      reservationCandidates: [
        {
          id: 'run-space',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          phase: 'text',
        },
      ],
      undispatchedSpaceSlices: [
        {
          runId: 'run-space',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          knowledgeGeneration: 4,
          jobPhase: 'text',
          spaceJobSequence: 1,
          spaceJobId: 'knowledge-space-text__run-space__text__1',
        },
      ],
    });

    await service.dispatchPending();

    expect(repo.reserveNextSpaceSlice).toHaveBeenCalledWith({
      runId: 'run-space',
    });
    expect(spaceQueue.add).toHaveBeenCalledWith(
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
    expect(repo.markSpaceSliceDispatched).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceJobId: 'knowledge-space-text__run-space__text__1',
      }),
    );
    expect(queue.add).not.toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      expect.anything(),
      expect.anything(),
    );
  });

  it('requests a queued run without exporter, catalog, image, or LLM planning', async () => {
    const { service, repo, catalog, sourceExporter, imageQueue, queue } =
      createService({
        pendingPages: [],
        pendingImages: [],
        pendingMerges: [],
        pendingAggregates: [],
      });
    repo.requestRuns.mockResolvedValue([
      {
        disposition: 'created',
        run: { id: 'queued-run', status: 'queued', initializedAt: null },
      },
    ]);

    await expect(
      service.requestRuns([
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          trigger: 'manual_compile',
          scanRemovedSources: true,
        },
      ]),
    ).resolves.toEqual([expect.objectContaining({ disposition: 'created' })]);

    expect(repo.requestRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [expect.objectContaining({ spaceId: 'space-1' })],
      }),
    );
    expect(catalog.snapshot).not.toHaveBeenCalled();
    expect(sourceExporter.exportPageSources).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(imageQueue.add).not.toHaveBeenCalled();
  });

  it('persists a catalog/source snapshot and dispatches idempotent page jobs', async () => {
    const { service, repo, queue, compilationRepo, catalog } = createService();

    await expect(
      service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        sources: [source()],
      }),
    ).resolves.toEqual(expect.objectContaining({ id: 'run-1' }));

    expect(catalog.snapshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        catalogSnapshot: [expect.objectContaining({ canonicalKey: 'alpha' })],
        catalogHash: 'sha256:aggregate-catalog',
        sources: [
          expect.objectContaining({
            sourcePageId: 'page-1',
            sourceVersion: 'v1',
            sourceContentHash: 'hash-1',
          }),
        ],
      }),
    );
    const jobId =
      'knowledge-compile-pages__workspace-1__space-1__page-1__run-1';
    expect(compilationRepo.queueAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ compileTaskId: jobId, compilerRunId: 'run-1' }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      expect.objectContaining({
        sourcePageIds: ['page-1'],
        spaceRunId: 'run-1',
        sourceVersion: 'v1',
        sourceContentHash: 'hash-1',
      }),
      expect.objectContaining({
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 31_000 },
      }),
    );
    expect(repo.markPageQueued).toHaveBeenCalledWith({
      runId: 'run-1',
      sourcePageId: 'page-1',
      jobId,
    });
  });

  it('creates 2,000 durable reused rows and dispatches zero page or aggregate jobs', async () => {
    const sources = Array.from({ length: 2_000 }, (_, index) =>
      source({
        sourcePageId: `page-${index}`,
        sourceVersion: `v-${index}`,
        contentHash: `sha256:source-${index}`,
      }),
    );
    const reuseCandidates = sources.map((item, index) =>
      reusableCandidate(item, index),
    );
    const { service, repo, queue } = createService({
      pendingPages: [],
      pendingAggregates: [],
      reuseCandidates,
      activeSourcePageIds: sources.map((item) => item.sourcePageId),
      latestAggregateRun: {
        phase: 'complete',
        status: 'succeeded',
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        catalogHash: 'sha256:aggregate-catalog',
        knowledgeGeneration: 4,
        currentKnowledgeGeneration: 4,
      },
      hasActiveOverview: true,
    });

    await service.startSpaceRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      sources,
    });

    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateRequired: false,
        sources: expect.arrayContaining([
          expect.objectContaining({
            sourcePageId: 'page-0',
            status: 'skipped',
            errorCode: 'unchanged',
          }),
          expect.objectContaining({
            sourcePageId: 'page-1999',
            status: 'skipped',
            errorCode: 'unchanged',
          }),
        ]),
      }),
    );
    expect(
      (repo.createRun.mock.calls[0][0] as { sources: unknown[] }).sources,
    ).toHaveLength(2_000);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy text phase', { phase: 'text' }, true],
    ['generation mismatch', { currentKnowledgeGeneration: 5 }, true],
    ['aggregate fingerprint mismatch', { catalogHash: 'sha256:old' }, true],
    ['nonterminal run', { status: 'compiling' }, true],
    ['trusted complete aggregate', {}, false],
  ])(
    'requires aggregation for %s',
    async (_label, runOverrides, aggregateRequired) => {
      const currentSource = source();
      const baselineRun = {
        phase: 'complete',
        status: 'succeeded',
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        catalogHash: 'sha256:aggregate-catalog',
        knowledgeGeneration: 4,
        currentKnowledgeGeneration: 4,
      };
      const { service, repo } = createService({
        reuseCandidates: [reusableCandidate(currentSource, 0)],
        activeSourcePageIds: [currentSource.sourcePageId],
        latestAggregateRun: { ...baselineRun, ...runOverrides },
        hasActiveOverview: true,
        pendingPages: [],
        pendingAggregates: [],
      });

      await service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        sources: [currentSource],
      });

      expect(repo.createRun).toHaveBeenCalledWith(
        expect.objectContaining({ aggregateRequired }),
      );
    },
  );

  it('requires aggregation when the overview artifact or its active memory chunk is absent', async () => {
    const currentSource = source();
    const { service, repo } = createService({
      reuseCandidates: [reusableCandidate(currentSource, 0)],
      activeSourcePageIds: [currentSource.sourcePageId],
      latestAggregateRun: {
        phase: 'complete',
        status: 'succeeded',
        compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
        promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
        catalogHash: 'sha256:aggregate-catalog',
        knowledgeGeneration: 4,
        currentKnowledgeGeneration: 4,
      },
      hasActiveOverview: false,
      pendingPages: [],
      pendingAggregates: [],
    });

    await service.startSpaceRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      sources: [currentSource],
    });

    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ aggregateRequired: true }),
    );
  });

  it('plans 999 reused pages and one changed page in one pass', async () => {
    const sources = Array.from({ length: 1_000 }, (_, index) =>
      source({
        sourcePageId: `page-${index}`,
        sourceVersion: 'v1',
        contentHash: `sha256:source-${index}`,
      }),
    );
    const reuseCandidates = sources
      .slice(0, 999)
      .map((item, index) => reusableCandidate(item, index));
    const { service, repo } = createService({
      reuseCandidates,
      activeSourcePageIds: sources.map((item) => item.sourcePageId),
      pendingPages: [],
      pendingAggregates: [],
    });

    await service.startSpaceRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      sources,
    });

    const planned = repo.createRun.mock.calls[0][0] as {
      aggregateRequired: boolean;
      sources: Array<{ sourcePageId: string; status: string }>;
    };
    expect(planned.aggregateRequired).toBe(true);
    expect(
      planned.sources.filter((item) => item.status === 'skipped'),
    ).toHaveLength(999);
    expect(planned.sources[planned.sources.length - 1]).toEqual(
      expect.objectContaining({ sourcePageId: 'page-999', status: 'pending' }),
    );
  });

  it('reuses the last valid publication after a failed retry but rejects missing active publication state', async () => {
    const sources = [
      'reused',
      'failed',
      'missing-source',
      'missing-summary',
      'version-mismatch',
    ].map((sourcePageId) => source({ sourcePageId }));
    const candidates = sources.map((item, index) =>
      reusableCandidate(item, index),
    );
    candidates[1].status = 'failed';
    candidates[2].activeSourceId = null;
    candidates[3].activeSummaryId = null;
    candidates[4].lastSuccessfulSourceVersion = 'old-version';
    const { service, repo } = createService({
      reuseCandidates: candidates,
      activeSourcePageIds: sources.map((item) => item.sourcePageId),
      pendingPages: [],
      pendingAggregates: [],
    });

    await service.startSpaceRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      sources,
    });

    const planned = (
      repo.createRun.mock.calls[0][0] as {
        sources: Array<{ sourcePageId: string; status: string }>;
      }
    ).sources;
    expect(
      planned.map(({ sourcePageId, status }) => ({ sourcePageId, status })),
    ).toEqual([
      { sourcePageId: 'reused', status: 'skipped' },
      { sourcePageId: 'failed', status: 'skipped' },
      { sourcePageId: 'missing-source', status: 'pending' },
      { sourcePageId: 'missing-summary', status: 'pending' },
      { sourcePageId: 'version-mismatch', status: 'pending' },
    ]);
  });

  it('reuses image knowledge only when every ordered image has a current ready extraction', async () => {
    const attachmentVersion = '2026-07-28T01:00:00.000Z';
    const images = ['image-1', 'image-2'].map((attachmentId) => ({
      attachmentId,
      attachmentVersion,
      fileName: `${attachmentId}.png`,
      mimeType: 'image/png' as const,
      fileSize: 100,
    }));
    const imageSource = source({ sourcePageId: 'page-images', images });
    const readyExtractions = images.map((image, index) => ({
      id: `extraction-${index}`,
      workspaceId: 'workspace-1',
      attachmentId: image.attachmentId,
      attachmentVersion: new Date(attachmentVersion),
      currentAttachmentVersion: new Date(attachmentVersion),
      attachmentWorkspaceId: 'workspace-1',
      attachmentSpaceId: 'space-1',
      attachmentPageId: 'page-images',
      status: 'ready',
      cacheFingerprint: `sha256:fingerprint-${index}`,
      contentHash: `sha256:image-${index}`,
      model: 'qwen3.7-plus',
      promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
      ocrText: `OCR ${index}`,
      caption: `Caption ${index}`,
      updatedAt: new Date('2026-07-28T01:01:00.000Z'),
    }));
    const effectiveHash = buildEffectiveKnowledgeHash({
      sourceContentHash: imageSource.contentHash,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      readyImages: readyExtractions.map((item) => ({
        attachmentId: item.attachmentId,
        attachmentVersion,
        cacheFingerprint: item.cacheFingerprint,
        contentHash: item.contentHash,
        ocrText: item.ocrText,
        caption: item.caption,
      })),
    });
    const candidate = {
      ...reusableCandidate(imageSource, 0),
      lastSuccessfulEffectiveHash: effectiveHash,
    };
    const { service, repo } = createService({
      reuseCandidates: [candidate],
      readyExtractions,
      activeSourcePageIds: [imageSource.sourcePageId],
      pendingPages: [],
      pendingAggregates: [],
    });

    await service.startSpaceRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      sources: [imageSource],
    });
    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            status: 'skipped',
            expectedImageCount: 2,
            succeededImageCount: 2,
            imageStatus: 'succeeded',
            targetEffectiveKnowledgeHash: effectiveHash,
          }),
        ],
      }),
    );

    const invalidSecondExtractions = [
      { ...readyExtractions[1], status: 'failed' },
      {
        ...readyExtractions[1],
        attachmentVersion: new Date('2026-07-27T01:00:00.000Z'),
      },
      { ...readyExtractions[1], model: 'old-vision-model' },
      { ...readyExtractions[1], promptVersion: 'old-image-prompt' },
      { ...readyExtractions[1], ocrText: ' ', caption: '' },
    ];
    for (const invalidSecond of invalidSecondExtractions) {
      const withoutSecond = createService({
        reuseCandidates: [candidate],
        readyExtractions: [readyExtractions[0], invalidSecond],
        activeSourcePageIds: [imageSource.sourcePageId],
        pendingPages: [],
        pendingAggregates: [],
      });
      await withoutSecond.service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        sources: [imageSource],
      });
      const missingPlan = withoutSecond.repo.createRun.mock.calls[0][0] as {
        sources: Array<Record<string, unknown>>;
      };
      expect(missingPlan.sources[0]).toEqual(
        expect.objectContaining({
          status: 'pending',
          expectedImageCount: 2,
          succeededImageCount: 1,
          imageStatus: 'pending',
          targetEffectiveKnowledgeHash: buildEffectiveKnowledgeHash({
            sourceContentHash: imageSource.contentHash,
            compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
            promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
            readyImages: [
              {
                attachmentId: readyExtractions[0].attachmentId,
                attachmentVersion,
                cacheFingerprint: readyExtractions[0].cacheFingerprint,
                contentHash: readyExtractions[0].contentHash,
                ocrText: readyExtractions[0].ocrText,
                caption: readyExtractions[0].caption,
              },
            ],
          }),
        }),
      );
    }
  });

  it('retires only source pages absent from the exported Space snapshot and forces aggregation', async () => {
    const { service, repo, sourceRepo, capsuleRepo, contributionRepo } =
      createService({
        reuseCandidates: [reusableCandidate(source(), 0)],
        activeSourcePageIds: ['page-1', 'removed-page'],
        pendingPages: [],
        pendingAggregates: [],
        executeRetirement: true,
      });

    await service.startSpaceRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      sources: [source()],
    });

    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ aggregateRequired: true }),
    );
    expect(sourceRepo.markSpaceSourcesStale).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['removed-page'],
      },
      expect.anything(),
    );
    expect(
      capsuleRepo.markSourceSummaryArtifactsStaleBySourcePageIds,
    ).not.toHaveBeenCalled();
    expect(
      contributionRepo.deleteSpaceSourceContributions,
    ).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['removed-page'],
      },
      expect.anything(),
    );
    expect(capsuleRepo.markArtifactsStaleByIds).not.toHaveBeenCalled();
  });

  it('stales only orphan artifacts and recompiles remaining sources affected by removed contributions', async () => {
    const { service, repo, capsuleRepo } = createService({
      reuseCandidates: [reusableCandidate(source(), 0)],
      activeSourcePageIds: ['page-1', 'removed-page'],
      remainingSourcesAffectedByRemoval: ['page-1'],
      orphanedArtifactIds: ['orphan-artifact'],
      pendingPages: [],
      pendingAggregates: [],
      executeRetirement: true,
    });

    await service.startSpaceRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      sources: [source()],
    });

    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [expect.objectContaining({ status: 'pending' })],
      }),
    );
    expect(capsuleRepo.markArtifactsStaleByIds).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        artifactIds: ['orphan-artifact'],
      },
      expect.anything(),
    );
  });

  it('removes stale source ids that survive only in current Space contributions', async () => {
    const { service, sourceRepo, contributionRepo } = createService({
      activeSourcePageIds: [],
      contributionSourcePageIds: ['stale-but-contributing'],
      pendingPages: [],
      pendingAggregates: [],
      executeRetirement: true,
    });

    await service.startSpaceRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      trigger: 'manual_compile',
      sources: [source()],
    });

    expect(sourceRepo.markSpaceSourcesStale).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['stale-but-contributing'],
      },
      expect.anything(),
    );
    expect(
      contributionRepo.deleteSpaceSourceContributions,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePageIds: ['stale-but-contributing'],
      }),
      expect.anything(),
    );
  });

  it('does not clean or dispatch when the locked repo rejects a stale command', async () => {
    const requestedAt = new Date('2026-07-27T03:00:00.000Z');
    const { service, repo, queue } = createService({
      createRunResult: {
        created: false,
        run: { id: 'run-newer', status: 'compiling' },
        supersededRunIds: [],
        supersededJobIds: [],
      },
      pendingPages: [],
    });
    await expect(
      service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        requestedAt,
        sources: [source()],
      }),
    ).resolves.toBeNull();

    expect(repo.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ requestedAt }),
    );
    expect(repo.findPendingPageDispatches).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('removes superseded waiting jobs before dispatching the new run', async () => {
    const waiting = queueJob('waiting');
    const delayed = queueJob('delayed');
    const paused = queueJob('paused');
    const active = queueJob('active');
    const completed = queueJob('completed');
    const { service, repo, queue } = createService({
      createRunResult: {
        run: { id: 'run-2', status: 'queued' },
        supersededRunIds: ['run-1'],
        supersededJobIds: [
          'waiting-job',
          'delayed-job',
          'paused-job',
          'active-job',
          'completed-job',
        ],
      },
      queueJobs: {
        'waiting-job': waiting,
        'delayed-job': delayed,
        'paused-job': paused,
        'active-job': active,
        'completed-job': completed,
      },
      pendingPages: [],
    });

    await expect(
      service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        sources: [source()],
      }),
    ).resolves.toEqual({ id: 'run-2', status: 'queued' });

    expect(queue.getJob).toHaveBeenCalledTimes(5);
    expect(waiting.remove).toHaveBeenCalledTimes(1);
    expect(delayed.remove).toHaveBeenCalledTimes(1);
    expect(paused.remove).toHaveBeenCalledTimes(1);
    expect(active.remove).not.toHaveBeenCalled();
    expect(completed.remove).not.toHaveBeenCalled();
    expect(repo.findPendingPageDispatches).toHaveBeenCalledTimes(1);
    expect(waiting.remove.mock.invocationCallOrder[0]).toBeLessThan(
      repo.findPendingPageDispatches.mock.invocationCallOrder[0],
    );
  });

  it('warns on an individual cancellation failure and still dispatches the new run', async () => {
    const failedRemoval = queueJob('waiting');
    failedRemoval.remove.mockRejectedValueOnce(new Error('redis unavailable'));
    const { service, repo } = createService({
      createRunResult: {
        run: { id: 'run-2', status: 'queued' },
        supersededRunIds: ['run-1'],
        supersededJobIds: ['failed-removal'],
      },
      queueJobs: { 'failed-removal': failedRemoval },
      pendingPages: [],
    });
    const loggerWarn = jest
      .spyOn(
        (service as never as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await expect(
      service.startSpaceRun({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        trigger: 'manual_compile',
        sources: [source()],
      }),
    ).resolves.toEqual({ id: 'run-2', status: 'queued' });

    expect(repo.findPendingPageDispatches).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('failed-removal'),
    );
  });

  it('queues a retry as an idempotent page job and records its attempt', async () => {
    const { service, queue, compilationRepo } = createService({
      pendingPages: [],
    });

    await expect(service.queuePageRetry(source())).resolves.toMatch(
      /^knowledge-retry-page__workspace-1__space-1__page-1__[a-f0-9]{64}$/,
    );

    const jobId = (queue.add.mock.calls[0][2] as { jobId: string }).jobId;
    expect(compilationRepo.queueAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      sourceContentHash: 'hash-1',
      compilerVersion: expect.any(String),
      promptVersion: expect.any(String),
      compilerRunId: jobId,
      compileTaskId: jobId,
    });
    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGES,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageIds: ['page-1'],
        sourceVersion: 'v1',
        sourceContentHash: 'hash-1',
        trigger: 'retry_compile',
      },
      expect.objectContaining({
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 31_000 },
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it('checks the exact run identity for processor fencing', async () => {
    const { service, repo } = createService({ pendingPages: [] });

    await expect(
      service.isRunActive({
        runId: 'run-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
      }),
    ).resolves.toBe(true);

    expect(repo.isRunActive).toHaveBeenCalledWith({
      runId: 'run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });
  });

  it('dispatches aggregate-pending runs with a stable job id', async () => {
    const { service, repo, queue } = createService({
      pendingPages: [],
      pendingAggregates: [
        {
          id: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          knowledgeGeneration: 4,
          phase: 'text',
        },
      ],
    });

    await service.dispatchPending();

    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
      {
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        spaceRunId: 'run-1',
        knowledgeGeneration: 4,
        phase: 'initial_aggregate',
      },
      expect.objectContaining({
        jobId: 'knowledge-aggregate-space__run-1__initial_aggregate',
        attempts: 3,
      }),
    );
    expect(repo.markAggregationQueued).toHaveBeenCalledWith({
      runId: 'run-1',
      phase: 'initial_aggregate',
      jobId: 'knowledge-aggregate-space__run-1__initial_aggregate',
    });
  });

  it('removes a page job and skips its attempt when the run is superseded before the outbox mark', async () => {
    const jobId =
      'knowledge-compile-pages__workspace-1__space-1__page-1__run-1';
    const waiting = queueJob('waiting');
    const { service, compilationRepo } = createService({
      markPageQueuedResult: false,
      queueJobs: { [jobId]: waiting },
    });

    await service.dispatchPending();

    expect(waiting.remove).toHaveBeenCalledTimes(1);
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: jobId,
      reasonCode: 'run_superseded',
      reasonMessage: 'Knowledge Space run was superseded before dispatch.',
    });
  });

  it('leaves an active page job for worker fencing but still skips the queued attempt', async () => {
    const jobId =
      'knowledge-compile-pages__workspace-1__space-1__page-1__run-1';
    const active = queueJob('active');
    const { service, compilationRepo } = createService({
      markPageQueuedResult: false,
      queueJobs: { [jobId]: active },
    });

    await service.dispatchPending();

    expect(active.remove).not.toHaveBeenCalled();
    expect(compilationRepo.skipAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        compileTaskId: jobId,
        reasonCode: 'run_superseded',
      }),
    );
  });

  it('removes an aggregate job when the run is superseded before the outbox mark', async () => {
    const jobId = 'knowledge-aggregate-space__run-1__initial_aggregate';
    const waiting = queueJob('waiting');
    const { service, compilationRepo } = createService({
      pendingPages: [],
      pendingAggregates: [
        {
          id: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          knowledgeGeneration: 4,
          phase: 'text',
        },
      ],
      markAggregationQueuedResult: false,
      queueJobs: { [jobId]: waiting },
    });

    await service.dispatchPending();

    expect(waiting.remove).toHaveBeenCalledTimes(1);
    expect(compilationRepo.skipAttempt).not.toHaveBeenCalled();
  });

  it('dispatches one page-sized image job only from the images phase outbox', async () => {
    const imageSource = source({
      images: [
        {
          attachmentId: 'image-1',
          fileName: 'diagram.png',
          mimeType: 'image/png',
          fileSize: 10,
          attachmentVersion: '2026-07-28T00:00:00.000Z',
        },
      ],
    });
    const { service, imageQueue, repo } = createService({
      pendingPages: [],
      pendingAggregates: [],
      pendingImages: [
        {
          runId: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          expectedSourceVersion: 'v1',
          expectedSourceContentHash: 'hash-1',
          knowledgeGeneration: 4,
        },
      ],
      imageSources: [imageSource],
    });

    await service.dispatchPending();

    expect(imageQueue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_COMPILE_PAGE_IMAGES,
      expect.objectContaining({
        spaceRunId: 'run-1',
        sourcePageId: 'page-1',
        sourceContentHash: 'hash-1',
        knowledgeGeneration: 4,
        images: imageSource.images,
      }),
      expect.objectContaining({
        attempts: 3,
        jobId: expect.stringMatching(
          /^knowledge-compile-page-images__workspace-1__space-1__run-1__page-1__4__/,
        ),
      }),
    );
    expect(repo.markPageImageQueued).toHaveBeenCalledTimes(1);
  });

  it('dispatches one deterministic merge job from durable pending state', async () => {
    const imageSource = source({
      images: [
        {
          attachmentId: 'image-1',
          fileName: 'diagram.png',
          mimeType: 'image/png',
          fileSize: 10,
          attachmentVersion: '2026-07-28T00:00:00.000Z',
        },
      ],
    });
    const { service, queue, repo } = createService({
      pendingPages: [],
      pendingAggregates: [],
      pendingImages: [],
      pendingMerges: [
        {
          runId: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          expectedSourceVersion: 'v1',
          expectedSourceContentHash: 'hash-1',
          knowledgeGeneration: 4,
        },
      ],
      imageSources: [imageSource],
      readyExtractions: [
        {
          id: 'extraction-1',
          sourcePageId: 'page-1',
          attachmentId: 'image-1',
          attachmentVersion: new Date('2026-07-28T00:00:00.000Z'),
          currentAttachmentVersion: new Date('2026-07-28T00:00:00.000Z'),
          workspaceId: 'workspace-1',
          attachmentWorkspaceId: 'workspace-1',
          attachmentSpaceId: 'space-1',
          attachmentPageId: 'page-1',
          status: 'ready',
          model: 'qwen3.7-plus',
          promptVersion: DEFAULT_KNOWLEDGE_IMAGE_PROMPT_VERSION,
          cacheFingerprint: 'cache-1',
          contentHash: 'sha256:image-1',
          ocrText: '架构图文字',
          caption: '架构图',
        },
      ],
    });

    await service.dispatchPending();
    await service.dispatchPending();

    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_MERGE_PAGE_IMAGES,
      expect.objectContaining({
        spaceRunId: 'run-1',
        sourcePageId: 'page-1',
        effectiveKnowledgeHash: expect.any(String),
        images: imageSource.images,
      }),
      expect.objectContaining({
        jobId: expect.stringMatching(
          /^knowledge-merge-page-images__workspace-1__space-1__run-1__page-1__4__/,
        ),
      }),
    );
    const firstId = jest.mocked(queue.add).mock.calls[0][2]?.jobId;
    expect(jest.mocked(queue.add).mock.calls[1][2]?.jobId).toBe(firstId);
    expect(repo.markPageMergeQueued).toHaveBeenCalledTimes(2);
  });

  it('uses the aggregate phase in the durable job identity', async () => {
    const { service, queue, repo } = createService({
      pendingPages: [],
      pendingImages: [],
      pendingMerges: [],
      pendingAggregates: [
        {
          id: 'run-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          knowledgeGeneration: 4,
          phase: 'final_aggregate',
        },
      ],
    });

    await service.dispatchPending();

    expect(queue.add).toHaveBeenCalledWith(
      QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
      expect.objectContaining({ phase: 'final_aggregate' }),
      expect.objectContaining({
        jobId: 'knowledge-aggregate-space__run-1__final_aggregate',
      }),
    );
    expect(repo.markAggregationQueued).toHaveBeenCalledWith({
      runId: 'run-1',
      phase: 'final_aggregate',
      jobId: 'knowledge-aggregate-space__run-1__final_aggregate',
    });
  });
});

function createService(
  overrides: {
    pendingPages?: unknown[];
    pendingAggregates?: unknown[];
    pendingImages?: unknown[];
    pendingMerges?: unknown[];
    imageSources?: KnowledgeSourceSnapshot[];
    createRunResult?: unknown;
    queueJobs?: Record<string, ReturnType<typeof queueJob>>;
    markPageQueuedResult?: boolean;
    markAggregationQueuedResult?: boolean;
    reuseCandidates?: unknown[];
    readyExtractions?: unknown[];
    activeSourcePageIds?: string[];
    contributionSourcePageIds?: string[];
    latestAggregateRun?: unknown;
    hasActiveOverview?: boolean;
    executeRetirement?: boolean;
    remainingSourcesAffectedByRemoval?: string[];
    orphanedArtifactIds?: string[];
    enableSpaceQueue?: boolean;
    reservationCandidates?: unknown[];
    undispatchedSpaceSlices?: unknown[];
  } = {},
) {
  const pendingPages = overrides.pendingPages ?? [
    {
      runId: 'run-1',
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      expectedSourceVersion: 'v1',
      expectedSourceContentHash: 'hash-1',
      trigger: 'manual_compile',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    },
  ];
  const repo = {
    requestRuns: jest.fn().mockResolvedValue([]),
    createRun: jest.fn().mockImplementation(async (input) => {
      if (overrides.executeRetirement && input.retireRemovedSources) {
        await input.retireRemovedSources({ transaction: true });
      }
      return (
        overrides.createRunResult ?? {
          run: { id: 'run-1', status: 'queued' },
          supersededRunIds: [],
          supersededJobIds: [],
        }
      );
    }),
    findPendingPageDispatches: jest.fn().mockResolvedValue(pendingPages),
    markPageQueued: jest
      .fn()
      .mockResolvedValue(overrides.markPageQueuedResult ?? true),
    findAggregatePendingRuns: jest
      .fn()
      .mockResolvedValue(overrides.pendingAggregates ?? []),
    findPendingImageDispatches: jest
      .fn()
      .mockResolvedValue(overrides.pendingImages ?? []),
    findPendingMergeDispatches: jest
      .fn()
      .mockResolvedValue(overrides.pendingMerges ?? []),
    markPageImageQueued: jest.fn().mockResolvedValue(true),
    markPageMergeQueued: jest.fn().mockResolvedValue(true),
    completePageImages: jest.fn().mockResolvedValue(true),
    getSpaceKnowledgeGeneration: jest.fn().mockResolvedValue(4),
    markAggregationQueued: jest
      .fn()
      .mockResolvedValue(overrides.markAggregationQueuedResult ?? true),
    hasActiveRun: jest.fn().mockResolvedValue(false),
    isRunActive: jest.fn().mockResolvedValue(true),
    findLatestRunForAggregateReuse: jest
      .fn()
      .mockResolvedValue(overrides.latestAggregateRun),
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
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    getJob: jest
      .fn()
      .mockImplementation(async (jobId: string) =>
        Object.prototype.hasOwnProperty.call(overrides.queueJobs ?? {}, jobId)
          ? overrides.queueJobs?.[jobId]
          : undefined,
      ),
  };
  const imageQueue = {
    add: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
  const spaceQueue = {
    add: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
  const sourceExporter = {
    exportPageSources: jest
      .fn()
      .mockResolvedValue(overrides.imageSources ?? []),
  };
  const compilationRepo = {
    queueAttempt: jest.fn().mockResolvedValue(undefined),
    skipAttempt: jest.fn().mockResolvedValue(undefined),
    findSpaceReuseCandidates: jest
      .fn()
      .mockResolvedValue(overrides.reuseCandidates ?? []),
  };
  const catalog = {
    snapshot: jest.fn().mockResolvedValue({
      entries: [
        {
          artifactId: 'artifact-1',
          artifactKind: 'concept',
          canonicalKey: 'alpha',
          title: 'Alpha',
          summary: 'Alpha body',
        },
      ],
      hash: 'sha256:catalog',
    }),
    aggregateFingerprint: jest.fn().mockResolvedValue({
      hash: 'sha256:aggregate-catalog',
      artifactCount: 1,
      truncated: false,
    }),
  };
  const sourceRepo = {
    findActiveSourcePageIdsBySpace: jest
      .fn()
      .mockResolvedValue(overrides.activeSourcePageIds ?? []),
    markSpaceSourcesStale: jest.fn().mockResolvedValue(undefined),
  };
  const imageExtractionRepo = {
    findCurrentReadyForSnapshotImages: jest
      .fn()
      .mockResolvedValue(overrides.readyExtractions ?? []),
  };
  const capsuleRepo = {
    hasActiveSpaceOverview: jest
      .fn()
      .mockResolvedValue(overrides.hasActiveOverview ?? false),
    markSourceSummaryArtifactsStaleBySourcePageIds: jest
      .fn()
      .mockResolvedValue(undefined),
    markArtifactsStaleByIds: jest.fn().mockResolvedValue(undefined),
  };
  const contributionRepo = {
    findSpaceSourcePageIds: jest
      .fn()
      .mockResolvedValue(overrides.contributionSourcePageIds ?? []),
    findRemainingSourcePageIdsForRemovedSources: jest
      .fn()
      .mockResolvedValue(overrides.remainingSourcesAffectedByRemoval ?? []),
    deleteSpaceSourceContributions: jest.fn().mockResolvedValue({
      orphanedArtifactIds: overrides.orphanedArtifactIds ?? [],
    }),
  };
  const environmentService = {
    getAiVisionModel: jest.fn().mockReturnValue('qwen3.7-plus'),
  };
  const service = new KnowledgeSpaceCompilationService(
    queue as unknown as Queue,
    imageQueue as unknown as Queue,
    repo as unknown as KnowledgeSpaceCompilationRepo,
    compilationRepo as unknown as KnowledgeCompilationRepo,
    catalog as unknown as KnowledgeArtifactCatalogService,
    sourceRepo as unknown as KnowledgeSourceRepo,
    imageExtractionRepo as unknown as KnowledgeImageExtractionRepo,
    capsuleRepo as unknown as KnowledgeCapsuleRepo,
    contributionRepo as unknown as KnowledgeArtifactContributionRepo,
    environmentService as unknown as EnvironmentService,
    sourceExporter as never,
    undefined,
    overrides.enableSpaceQueue ? (spaceQueue as unknown as Queue) : undefined,
  );
  return {
    service,
    repo,
    queue,
    imageQueue,
    spaceQueue,
    compilationRepo,
    catalog,
    sourceRepo,
    imageExtractionRepo,
    capsuleRepo,
    contributionRepo,
    environmentService,
    sourceExporter,
  };
}

function queueJob(state: string) {
  return {
    getState: jest.fn().mockResolvedValue(state),
    remove: jest.fn().mockResolvedValue(undefined),
  };
}

function source(
  overrides: Partial<KnowledgeSourceSnapshot> = {},
): KnowledgeSourceSnapshot {
  return { ...baseSource(), ...overrides };
}

function baseSource() {
  return {
    workspaceId: 'workspace-1',
    spaceId: 'space-1',
    sourcePageId: 'page-1',
    sourceVersion: 'v1',
    contentHash: 'hash-1',
    title: 'Page',
    text: 'Body',
    references: [],
  };
}

function reusableCandidate(item: ReturnType<typeof source>, index: number) {
  return {
    sourcePageId: item.sourcePageId,
    status: 'succeeded',
    lastSuccessfulSourceVersion: item.sourceVersion,
    lastSuccessfulSourceHash: item.contentHash,
    lastSuccessfulEffectiveHash: buildEffectiveKnowledgeHash({
      sourceContentHash: item.contentHash,
      compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
      promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
      readyImages: [],
    }),
    compilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
    promptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
    activeSourceId: `source-${index}` as string | null,
    activeSummaryId: `summary-${index}` as string | null,
    activeSummaryChunkId: `summary-chunk-${index}` as string | null,
    contributionSourceVersion: item.sourceVersion,
    contributionSourceHash: item.contentHash,
    contributionCompilerVersion: DEFAULT_KNOWLEDGE_COMPILER_VERSION,
    contributionPromptVersion: DEFAULT_KNOWLEDGE_PROMPT_VERSION,
  };
}
