import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { KnowledgeQuarantineRepo } from '@akasha/db/repos/llm-wiki/knowledge-quarantine.repo';
import { KnowledgeQueryAuditRepo } from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import { QueueName } from '../../../integrations/queue/constants';
import {
  KNOWLEDGE_IMAGE_WORKER_OPTIONS,
  KNOWLEDGE_SPACE_WORKER_OPTIONS,
  KNOWLEDGE_WORKER_SETTINGS,
} from './knowledge-worker-settings';
import { getKnowledgeWorkerEventSnapshot } from './knowledge-worker-observability';
import { KnowledgeQualityService } from './knowledge-quality.service';

export type KnowledgeQueueCounts = {
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  waitingChildren: number;
  paused: number;
  failed: number;
  completed: number;
};

export type KnowledgeQueueSnapshot = KnowledgeQueueCounts & {
  sampledAt: string;
};

export type KnowledgeOperationalQueueSnapshots = {
  space: KnowledgeQueueSnapshot;
  image: KnowledgeQueueSnapshot;
};

export type WorkerCapacityEstimate = {
  workerCount: number | null;
  capacity: number | null;
  exact: false;
  source: 'bullmq_client_list' | 'unsupported' | 'unavailable';
};

export type KnowledgeRunDiagnosticsSummary = {
  sampledAt: string;
  activeRunCount: number;
  activeSpaceSlotRunCount: number;
  waitingInitializationCount: number;
  queuedRunCount: number;
  recentCompletedCount: number;
  recentFailedCount: number;
  recentYieldCount: number;
  longestCurrentSlotWaitMs: number | null;
  statusCounts: Record<string, number>;
  phaseCounts: Record<string, number>;
  dispatch: {
    spaceUnacknowledged: number;
    imageUnacknowledged: number;
  };
  recovery: {
    expiredExecutionLeases: number;
    spaceRecovering: number;
    spaceRecoveryExhausted: number;
    imageRecovering: number;
    imageRecoveryExhausted: number;
  };
  imageStatusCounts: Record<string, number>;
  failureCategories: {
    budgetTimeout: number;
    provider: number;
    publication: number;
    infrastructure: number;
    other: number;
  };
  queues?: KnowledgeOperationalQueueSnapshots;
  workerEvents: ReturnType<typeof getKnowledgeWorkerEventSnapshot>;
};

export function buildWorkerCapacityEstimate(
  workers: Array<{ name?: string }> | undefined,
  concurrency: number,
): WorkerCapacityEstimate {
  if (!workers) {
    return {
      workerCount: null,
      capacity: null,
      exact: false,
      source: 'unavailable',
    };
  }
  if (
    workers.some((worker) =>
      String(worker.name ?? '')
        .toLowerCase()
        .includes('does not support client list'),
    )
  ) {
    return {
      workerCount: null,
      capacity: null,
      exact: false,
      source: 'unsupported',
    };
  }
  return {
    workerCount: workers.length,
    capacity: workers.length * concurrency,
    exact: false,
    source: 'bullmq_client_list',
  };
}

export function classifyRunQueueState(input: {
  status: string;
  phase: string;
  initializedAt: Date | null;
}):
  | 'waiting_initialization'
  | 'text_continuation'
  | 'image_merge_continuation'
  | 'queued'
  | null {
  if (input.status !== 'queued') return null;
  if (input.phase === 'text') {
    return input.initializedAt ? 'text_continuation' : 'waiting_initialization';
  }
  if (input.phase === 'image_merge') return 'image_merge_continuation';
  return 'queued';
}

@Injectable()
export class KnowledgeDiagnosticsService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.KNOWLEDGE_IMAGE_QUEUE)
    private readonly knowledgeImageQueue: Queue,
    @InjectQueue(QueueName.KNOWLEDGE_SPACE_QUEUE)
    private readonly knowledgeSpaceQueue: Queue,
    private readonly qualityService: KnowledgeQualityService,
    private readonly quarantineRepo: KnowledgeQuarantineRepo,
    private readonly queryAuditRepo: KnowledgeQueryAuditRepo,
  ) {}

  async getQualityDiagnostics(input: {
    workspaceId: string;
    spaceIds: string[];
  }) {
    return this.qualityService.getReport(input);
  }

  async listQuarantineDiagnostics(input: {
    workspaceId: string;
    spaceIds: string[];
    page?: number;
    limit?: number;
  }) {
    return this.quarantineRepo.listDiagnosticsPage(input);
  }

  async getRetrievalDiagnostics(input: { workspaceId: string }) {
    return this.queryAuditRepo.summarizeWorkspace({
      workspaceId: input.workspaceId,
      limit: 500,
    });
  }

  async getRunDiagnosticsSummary(input: {
    workspaceId: string;
    spaceIds: string[];
    enforceSpaceScope: boolean;
    canViewGlobalQueues: boolean;
  }): Promise<KnowledgeRunDiagnosticsSummary> {
    const sampledAt = new Date();
    const emptyScope = input.enforceSpaceScope && input.spaceIds.length === 0;
    let runGroups: Array<{ status: string; phase: string; count: unknown }> =
      [];
    let runMetrics: Record<string, unknown> | undefined;
    let imageGroups: Array<{ status: string; count: unknown }> = [];
    let imageMetrics: Record<string, unknown> | undefined;
    let failureMetrics: Record<string, unknown> | undefined;

    if (!emptyScope) {
      let runs = this.db
        .selectFrom('knowledgeSpaceCompileRuns as run')
        .where('run.workspaceId', '=', input.workspaceId);
      let images = this.db
        .selectFrom('knowledgeSpaceCompileRunImages as image')
        .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'image.runId')
        .where('run.workspaceId', '=', input.workspaceId);
      let pages = this.db
        .selectFrom('knowledgeSpaceCompileRunPages as rp')
        .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'rp.runId')
        .where('run.workspaceId', '=', input.workspaceId);
      if (input.spaceIds.length > 0) {
        runs = runs.where('run.spaceId', 'in', input.spaceIds);
        images = images.where('run.spaceId', 'in', input.spaceIds);
        pages = pages.where('run.spaceId', 'in', input.spaceIds);
      }

      [runGroups, runMetrics, imageGroups, imageMetrics, failureMetrics] =
        await Promise.all([
          runs
            .select(['run.status', 'run.phase'])
            .select((eb) => eb.fn.countAll().as('count'))
            .groupBy(['run.status', 'run.phase'])
            .execute() as Promise<
            Array<{ status: string; phase: string; count: unknown }>
          >,
          runs
            .select([
              sql<number>`count(*) filter (where run.status in ('queued', 'compiling', 'aggregate_pending', 'aggregating'))`.as(
                'activeRunCount',
              ),
              sql<number>`count(*) filter (where run.status in ('compiling', 'aggregating') and run.phase in ('text', 'image_merge', 'finalizing'))`.as(
                'activeSpaceSlotRunCount',
              ),
              sql<number>`count(*) filter (where run.status = 'queued')`.as(
                'queuedRunCount',
              ),
              sql<number>`count(*) filter (where run.status = 'queued' and run.phase = 'text' and run.initialized_at is null)`.as(
                'waitingInitializationCount',
              ),
              sql<number>`count(*) filter (where run.status in ('succeeded', 'partial') and run.finished_at >= now() - interval '1 hour')`.as(
                'recentCompletedCount',
              ),
              sql<number>`count(*) filter (where run.status = 'failed' and run.finished_at >= now() - interval '1 hour')`.as(
                'recentFailedCount',
              ),
              sql<number>`count(*) filter (where run.last_yield_at >= now() - interval '1 hour')`.as(
                'recentYieldCount',
              ),
              sql<Date>`min(run.space_job_queued_at) filter (where run.status = 'queued' and run.phase in ('text', 'image_merge', 'finalizing'))`.as(
                'oldestSpaceJobQueuedAt',
              ),
              sql<number>`count(*) filter (where run.status = 'queued' and run.space_job_id is not null and run.space_job_dispatched_at is null)`.as(
                'spaceUnacknowledged',
              ),
              sql<number>`count(*) filter (where run.execution_lease_expires_at < now() and run.status in ('compiling', 'aggregating'))`.as(
                'expiredExecutionLeases',
              ),
              sql<number>`count(*) filter (where run.space_job_recovery_count > 0 and run.status in ('queued', 'compiling', 'aggregating'))`.as(
                'spaceRecovering',
              ),
              sql<number>`count(*) filter (where run.status = 'failed' and run.error_code = 'redis_job_missing_exhausted')`.as(
                'spaceRecoveryExhausted',
              ),
            ])
            .executeTakeFirst() as Promise<Record<string, unknown>>,
          images
            .select('image.status')
            .select((eb) => eb.fn.countAll().as('count'))
            .groupBy('image.status')
            .execute() as Promise<Array<{ status: string; count: unknown }>>,
          images
            .select([
              sql<number>`count(*) filter (where image.status = 'queued' and image.job_id is not null and image.dispatched_at is null)`.as(
                'imageUnacknowledged',
              ),
              sql<number>`count(*) filter (where image.redis_recovery_count > 0 and image.status in ('queued', 'processing'))`.as(
                'imageRecovering',
              ),
              sql<number>`count(*) filter (where image.status = 'failed' and image.error_code = 'image_redis_job_missing_exhausted')`.as(
                'imageRecoveryExhausted',
              ),
            ])
            .executeTakeFirst() as Promise<Record<string, unknown>>,
          pages
            .select([
              sql<number>`count(*) filter (where (rp.status = 'failed' or rp.merge_status = 'failed') and rp.error_code = 'page_timeout')`.as(
                'budgetTimeout',
              ),
              sql<number>`count(*) filter (where (rp.status = 'failed' or rp.merge_status = 'failed') and rp.error_code <> 'page_timeout' and (rp.error_code ilike '%provider%' or rp.error_code ilike '%llm%' or rp.error_code in ('rate_limited', 'invalid_output')))`.as(
                'provider',
              ),
              sql<number>`count(*) filter (where (rp.status = 'failed' or rp.merge_status = 'failed') and (rp.error_code ilike '%publication%' or rp.error_code ilike '%import%' or rp.error_code ilike '%merge%'))`.as(
                'publication',
              ),
              sql<number>`count(*) filter (where (rp.status = 'failed' or rp.merge_status = 'failed') and (rp.error_code ilike '%storage%' or rp.error_code ilike '%database%' or rp.error_code ilike '%job%' or rp.error_code ilike '%embedding%'))`.as(
                'infrastructure',
              ),
              sql<number>`count(*) filter (where rp.status = 'failed' or rp.merge_status = 'failed')`.as(
                'failedTotal',
              ),
            ])
            .executeTakeFirst() as Promise<Record<string, unknown>>,
        ]);
    }

    const statusCounts: Record<string, number> = {};
    const phaseCounts: Record<string, number> = {};
    for (const row of runGroups) {
      const count = numberValue(row.count);
      statusCounts[row.status] = (statusCounts[row.status] ?? 0) + count;
      phaseCounts[row.phase] = (phaseCounts[row.phase] ?? 0) + count;
    }
    const imageStatusCounts = Object.fromEntries(
      imageGroups.map((row) => [row.status, numberValue(row.count)]),
    );
    const budgetTimeout = numberValue(failureMetrics?.budgetTimeout);
    const provider = numberValue(failureMetrics?.provider);
    const publication = numberValue(failureMetrics?.publication);
    const infrastructure = numberValue(failureMetrics?.infrastructure);
    const failedTotal = numberValue(failureMetrics?.failedTotal);
    const oldestQueuedAt = dateValue(runMetrics?.oldestSpaceJobQueuedAt);
    const queues = input.canViewGlobalQueues
      ? await this.findOperationalQueueSnapshots()
      : undefined;

    return {
      sampledAt: sampledAt.toISOString(),
      activeRunCount: numberValue(runMetrics?.activeRunCount),
      activeSpaceSlotRunCount: numberValue(runMetrics?.activeSpaceSlotRunCount),
      waitingInitializationCount: numberValue(
        runMetrics?.waitingInitializationCount,
      ),
      queuedRunCount: numberValue(runMetrics?.queuedRunCount),
      recentCompletedCount: numberValue(runMetrics?.recentCompletedCount),
      recentFailedCount: numberValue(runMetrics?.recentFailedCount),
      recentYieldCount: numberValue(runMetrics?.recentYieldCount),
      longestCurrentSlotWaitMs: oldestQueuedAt
        ? Math.max(0, sampledAt.getTime() - oldestQueuedAt.getTime())
        : null,
      statusCounts,
      phaseCounts,
      dispatch: {
        spaceUnacknowledged: numberValue(runMetrics?.spaceUnacknowledged),
        imageUnacknowledged: numberValue(imageMetrics?.imageUnacknowledged),
      },
      recovery: {
        expiredExecutionLeases: numberValue(runMetrics?.expiredExecutionLeases),
        spaceRecovering: numberValue(runMetrics?.spaceRecovering),
        spaceRecoveryExhausted: numberValue(runMetrics?.spaceRecoveryExhausted),
        imageRecovering: numberValue(imageMetrics?.imageRecovering),
        imageRecoveryExhausted: numberValue(
          imageMetrics?.imageRecoveryExhausted,
        ),
      },
      imageStatusCounts,
      failureCategories: {
        budgetTimeout,
        provider,
        publication,
        infrastructure,
        other: Math.max(
          0,
          failedTotal - budgetTimeout - provider - publication - infrastructure,
        ),
      },
      ...(queues ? { queues } : {}),
      workerEvents: getKnowledgeWorkerEventSnapshot(
        60 * 60 * 1_000,
        sampledAt.getTime(),
      ),
    };
  }

  async getWorkerDiagnostics() {
    const [spaceWorkers, imageWorkers] = await Promise.all([
      this.safeGetWorkers(this.knowledgeSpaceQueue),
      this.safeGetWorkers(this.knowledgeImageQueue),
    ]);
    return {
      sampledAt: new Date().toISOString(),
      databaseMaxPool: KNOWLEDGE_WORKER_SETTINGS.databaseMaxPool,
      space: {
        ...buildWorkerCapacityEstimate(
          spaceWorkers,
          KNOWLEDGE_SPACE_WORKER_OPTIONS.concurrency,
        ),
        concurrency: KNOWLEDGE_SPACE_WORKER_OPTIONS.concurrency,
        lockDuration: KNOWLEDGE_SPACE_WORKER_OPTIONS.lockDuration,
        stalledInterval: KNOWLEDGE_SPACE_WORKER_OPTIONS.stalledInterval,
        maxStalledCount: KNOWLEDGE_SPACE_WORKER_OPTIONS.maxStalledCount,
      },
      image: {
        ...buildWorkerCapacityEstimate(
          imageWorkers,
          KNOWLEDGE_IMAGE_WORKER_OPTIONS.concurrency,
        ),
        concurrency: KNOWLEDGE_IMAGE_WORKER_OPTIONS.concurrency,
        lockDuration: KNOWLEDGE_IMAGE_WORKER_OPTIONS.lockDuration,
        stalledInterval: KNOWLEDGE_IMAGE_WORKER_OPTIONS.stalledInterval,
        maxStalledCount: KNOWLEDGE_IMAGE_WORKER_OPTIONS.maxStalledCount,
      },
      schedulingAuthority: 'postgresql' as const,
    };
  }

  async listRunDiagnostics(input: {
    workspaceId: string;
    spaceIds: string[];
    enforceSpaceScope: boolean;
    statuses?: string[];
    phases?: string[];
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(input.page ?? 1, 1);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    if (input.enforceSpaceScope && input.spaceIds.length === 0) {
      return { items: [], total: 0, page, limit };
    }
    let query = this.db
      .selectFrom('knowledgeSpaceCompileRuns as run')
      .innerJoin('spaces as space', (join) =>
        join
          .onRef('space.id', '=', 'run.spaceId')
          .onRef('space.workspaceId', '=', 'run.workspaceId'),
      )
      .where('run.workspaceId', '=', input.workspaceId)
      .where('space.deletedAt', 'is', null);
    if (input.spaceIds.length > 0) {
      query = query.where('run.spaceId', 'in', input.spaceIds);
    }
    if (input.statuses?.length) {
      query = query.where('run.status', 'in', input.statuses);
    }
    if (input.phases?.length) {
      query = query.where('run.phase', 'in', input.phases);
    }
    const search = input.search?.trim();
    if (search) {
      query = query.where((eb) =>
        eb.or([
          eb('space.name', 'ilike', `%${search}%`),
          eb('run.id', 'ilike', `%${search}%`),
        ]),
      );
    }

    const [countRow, rows] = await Promise.all([
      query.select((eb) => eb.fn.countAll().as('count')).executeTakeFirst(),
      query
        .select([
          'run.id',
          'run.spaceId',
          'space.name as spaceName',
          'run.status',
          'run.mode',
          'run.phase',
          'run.knowledgeGeneration',
          'run.expectedPageCount',
          'run.succeededPageCount',
          'run.failedPageCount',
          'run.skippedPageCount',
          'run.initializedAt',
          'run.queuedAt',
          'run.startedAt',
          'run.finishedAt',
          'run.spaceJobQueuedAt',
          'run.spaceJobSequence',
          'run.lastYieldAt',
          'run.lastYieldReason',
          'run.workerId',
          'run.errorCode',
          'run.createdAt',
          'run.updatedAt',
        ])
        .orderBy('run.createdAt', 'desc')
        .orderBy('run.id', 'desc')
        .offset((page - 1) * limit)
        .limit(limit)
        .execute(),
    ]);
    const runIds = rows.map((row) => row.id);
    const progressRows =
      runIds.length === 0
        ? []
        : await this.db
            .selectFrom('knowledgeSpaceCompileRunPages as rp')
            .select('rp.runId')
            .select([
              sql<number>`coalesce(sum(rp.expected_image_count), 0)`.as(
                'expectedImageCount',
              ),
              sql<number>`coalesce(sum(rp.succeeded_image_count), 0)`.as(
                'succeededImageCount',
              ),
              sql<number>`coalesce(sum(rp.failed_image_count), 0)`.as(
                'failedImageCount',
              ),
              sql<number>`coalesce(sum(rp.skipped_image_count), 0)`.as(
                'skippedImageCount',
              ),
              sql<number>`count(*) filter (where rp.expected_image_count > 0)`.as(
                'expectedMergeCount',
              ),
              sql<number>`count(*) filter (where rp.merge_status = 'succeeded')`.as(
                'succeededMergeCount',
              ),
              sql<number>`count(*) filter (where rp.merge_status = 'failed')`.as(
                'failedMergeCount',
              ),
              sql<number>`count(*) filter (where rp.merge_status = 'skipped')`.as(
                'skippedMergeCount',
              ),
            ])
            .where('rp.runId', 'in', runIds)
            .groupBy('rp.runId')
            .execute();
    const progressByRun = new Map(
      progressRows.map((row) => [row.runId, row] as const),
    );
    const now = Date.now();

    return {
      items: rows.map((row) => {
        const progress = progressByRun.get(row.id);
        const totalEnd = row.finishedAt?.getTime() ?? now;
        return {
          runId: row.id,
          spaceId: row.spaceId,
          spaceName: row.spaceName,
          status: row.status,
          mode: row.mode,
          phase: row.phase,
          knowledgeGeneration: row.knowledgeGeneration,
          queueState: classifyRunQueueState(row),
          spaceJobSequence: row.spaceJobSequence,
          lastYieldAt: isoDate(row.lastYieldAt),
          lastYieldReason: row.lastYieldReason,
          workerId: row.workerId,
          errorCode: row.errorCode,
          initializedAt: isoDate(row.initializedAt),
          queuedAt: row.queuedAt.toISOString(),
          startedAt: isoDate(row.startedAt),
          finishedAt: isoDate(row.finishedAt),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          runDurationMs: Math.max(0, totalEnd - row.queuedAt.getTime()),
          currentSliceWaitMs:
            row.status === 'queued' && row.spaceJobQueuedAt
              ? Math.max(0, now - row.spaceJobQueuedAt.getTime())
              : null,
          progress: {
            text: {
              expected: row.expectedPageCount,
              succeeded: row.succeededPageCount,
              failed: row.failedPageCount,
              skipped: row.skippedPageCount,
            },
            images: {
              expected: numberValue(progress?.expectedImageCount),
              succeeded: numberValue(progress?.succeededImageCount),
              failed: numberValue(progress?.failedImageCount),
              skipped: numberValue(progress?.skippedImageCount),
            },
            merge: {
              expected: numberValue(progress?.expectedMergeCount),
              succeeded: numberValue(progress?.succeededMergeCount),
              failed: numberValue(progress?.failedMergeCount),
              skipped: numberValue(progress?.skippedMergeCount),
            },
          },
        };
      }),
      total: numberValue(countRow?.count),
      page,
      limit,
    };
  }

  async findRunDiagnosticSpaceId(input: {
    workspaceId: string;
    runId: string;
  }): Promise<string | undefined> {
    const run = await this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .select('spaceId')
      .where('workspaceId', '=', input.workspaceId)
      .where('id', '=', input.runId)
      .executeTakeFirst();
    return run?.spaceId;
  }

  async listRunPageDiagnostics(input: {
    workspaceId: string;
    runId: string;
    allowedSpaceIds: string[];
    page?: number;
    limit?: number;
    includeSensitiveErrors?: boolean;
  }) {
    const page = Math.max(input.page ?? 1, 1);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    if (input.allowedSpaceIds.length === 0) {
      return undefined;
    }
    const run = await this.db
      .selectFrom('knowledgeSpaceCompileRuns as run')
      .innerJoin('spaces as space', 'space.id', 'run.spaceId')
      .select(['run.id', 'run.spaceId', 'space.name as spaceName'])
      .where('run.workspaceId', '=', input.workspaceId)
      .where('run.id', '=', input.runId)
      .where('run.spaceId', 'in', input.allowedSpaceIds)
      .executeTakeFirst();
    if (!run) return undefined;

    const pages = this.db
      .selectFrom('knowledgeSpaceCompileRunPages as runPage')
      .leftJoin('pages as page', 'page.id', 'runPage.sourcePageId')
      .where('runPage.workspaceId', '=', input.workspaceId)
      .where('runPage.runId', '=', input.runId);
    const [countRow, rows] = await Promise.all([
      pages.select((eb) => eb.fn.countAll().as('count')).executeTakeFirst(),
      pages
        .select([
          'runPage.id as runPageId',
          'runPage.sourcePageId',
          'page.title',
          'page.slugId',
          'runPage.status',
          'runPage.imageStatus',
          'runPage.mergeStatus',
          'runPage.expectedImageCount',
          'runPage.succeededImageCount',
          'runPage.failedImageCount',
          'runPage.skippedImageCount',
          'runPage.expectedSourceVersion',
          'runPage.expectedSourceContentHash',
          'runPage.errorCode',
          'runPage.errorMessage',
          'runPage.queuedAt',
          'runPage.startedAt',
          'runPage.finishedAt',
          'runPage.updatedAt',
        ])
        .orderBy('runPage.updatedAt', 'desc')
        .orderBy('runPage.id', 'asc')
        .offset((page - 1) * limit)
        .limit(limit)
        .execute(),
    ]);
    const runPageIds = rows.map((row) => row.runPageId);
    const imageFailures =
      runPageIds.length === 0
        ? []
        : await this.db
            .selectFrom('knowledgeSpaceCompileRunImages')
            .select(['runPageId', 'failureClass'])
            .select((eb) => eb.fn.countAll().as('count'))
            .where('runPageId', 'in', runPageIds)
            .where('status', '=', 'failed')
            .groupBy(['runPageId', 'failureClass'])
            .execute();
    const imageFailuresByPage = new Map<
      string,
      { retryableExhausted: number; permanent: number }
    >();
    for (const row of imageFailures) {
      const current = imageFailuresByPage.get(row.runPageId) ?? {
        retryableExhausted: 0,
        permanent: 0,
      };
      if (row.failureClass === 'retryable_exhausted') {
        current.retryableExhausted += numberValue(row.count);
      } else if (row.failureClass === 'permanent') {
        current.permanent += numberValue(row.count);
      }
      imageFailuresByPage.set(row.runPageId, current);
    }

    return {
      run: {
        runId: run.id,
        spaceId: run.spaceId,
        spaceName: run.spaceName,
      },
      items: rows.map((row) => ({
        runPageId: row.runPageId,
        sourcePageId: row.sourcePageId,
        title: row.title ?? '',
        slugId: row.slugId ?? null,
        status: row.status,
        imageStatus: row.imageStatus,
        mergeStatus: row.mergeStatus,
        expectedImageCount: row.expectedImageCount,
        succeededImageCount: row.succeededImageCount,
        failedImageCount: row.failedImageCount,
        skippedImageCount: row.skippedImageCount,
        expectedSourceVersion: row.expectedSourceVersion,
        expectedSourceContentHash: row.expectedSourceContentHash,
        errorCode: row.errorCode,
        errorCategory: classifyRunPageError(row.errorCode),
        errorSummary: row.errorCode
          ? safeCompilationErrorMessage(row.errorCode)
          : null,
        ...(input.includeSensitiveErrors && row.errorMessage
          ? { errorDetail: sanitizeRunPageErrorDetail(row.errorMessage) }
          : {}),
        queuedAt: isoDate(row.queuedAt),
        startedAt: isoDate(row.startedAt),
        finishedAt: isoDate(row.finishedAt),
        updatedAt: row.updatedAt.toISOString(),
        imageFailures: imageFailuresByPage.get(row.runPageId) ?? {
          retryableExhausted: 0,
          permanent: 0,
        },
      })),
      total: numberValue(countRow?.count),
      page,
      limit,
    };
  }

  async listDelayedPageDiagnostics(input: {
    workspaceId: string;
    spaceIds: string[];
    enforceSpaceScope: boolean;
    statuses?: Array<'waiting' | 'due'>;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(input.page ?? 1, 1);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const sampledAtResult = await sql<{ sampledAt: Date }>`
      SELECT clock_timestamp() AS "sampledAt"
    `.execute(this.db);
    const sampledAt = sampledAtResult.rows[0].sampledAt;
    if (input.enforceSpaceScope && input.spaceIds.length === 0) {
      return {
        summary: {
          sampledAt: sampledAt.toISOString(),
          waitingPageCount: 0,
          duePageCount: 0,
          affectedSpaceCount: 0,
          oldestFirstChangedAt: null,
          nextEligibleAt: null,
        },
        items: [],
        total: 0,
        page,
        limit,
      };
    }

    let scope = this.db
      .selectFrom('knowledgePageCompileSchedules as schedule')
      .innerJoin('pages as sourcePage', (join) =>
        join
          .onRef('sourcePage.id', '=', 'schedule.sourcePageId')
          .onRef('sourcePage.workspaceId', '=', 'schedule.workspaceId'),
      )
      .innerJoin('spaces as space', (join) =>
        join
          .onRef('space.id', '=', 'schedule.spaceId')
          .onRef('space.workspaceId', '=', 'schedule.workspaceId'),
      )
      .where('schedule.workspaceId', '=', input.workspaceId)
      .where('sourcePage.deletedAt', 'is', null)
      .where('space.deletedAt', 'is', null);
    if (input.spaceIds.length > 0) {
      scope = scope.where('schedule.spaceId', 'in', input.spaceIds);
    }

    const summaryPromise = scope
      .select([
        sql<number>`count(*) filter (where schedule.eligible_at > ${sampledAt})`.as(
          'waitingPageCount',
        ),
        sql<number>`count(*) filter (where schedule.eligible_at <= ${sampledAt})`.as(
          'duePageCount',
        ),
        sql<number>`count(distinct schedule.space_id)`.as('affectedSpaceCount'),
        sql<Date>`min(schedule.first_changed_at)`.as('oldestFirstChangedAt'),
        sql<Date>`min(schedule.eligible_at)`.as('nextEligibleAt'),
      ])
      .executeTakeFirst();

    let list = scope;
    const statuses = [...new Set(input.statuses ?? [])];
    if (statuses.length === 1) {
      list =
        statuses[0] === 'waiting'
          ? list.where('schedule.eligibleAt', '>', sampledAt)
          : list.where('schedule.eligibleAt', '<=', sampledAt);
    }
    const search = input.search?.trim();
    if (search) {
      list = list.where((eb) =>
        eb.or([
          eb('sourcePage.title', 'ilike', `%${search}%`),
          eb('sourcePage.slugId', 'ilike', `%${search}%`),
          eb('space.name', 'ilike', `%${search}%`),
        ]),
      );
    }

    const [summaryRow, countRow, rows] = await Promise.all([
      summaryPromise,
      list.select((eb) => eb.fn.countAll().as('count')).executeTakeFirst(),
      list
        .select([
          'schedule.id',
          'schedule.sourcePageId',
          'schedule.spaceId',
          'space.name as spaceName',
          'sourcePage.title',
          'sourcePage.slugId',
          'schedule.trigger',
          'schedule.changeCount',
          'schedule.firstChangedAt',
          'schedule.lastChangedAt',
          'schedule.eligibleAt',
          'schedule.createdAt',
          'schedule.updatedAt',
        ])
        .orderBy('schedule.eligibleAt', 'asc')
        .orderBy('schedule.id', 'asc')
        .offset((page - 1) * limit)
        .limit(limit)
        .execute(),
    ]);

    return {
      summary: {
        sampledAt: sampledAt.toISOString(),
        waitingPageCount: numberValue(summaryRow?.waitingPageCount),
        duePageCount: numberValue(summaryRow?.duePageCount),
        affectedSpaceCount: numberValue(summaryRow?.affectedSpaceCount),
        oldestFirstChangedAt: isoDate(summaryRow?.oldestFirstChangedAt),
        nextEligibleAt: isoDate(summaryRow?.nextEligibleAt),
      },
      items: rows.map((row) => ({
        scheduleId: row.id,
        sourcePageId: row.sourcePageId,
        spaceId: row.spaceId,
        spaceName: row.spaceName,
        title: row.title ?? '',
        slugId: row.slugId,
        trigger: row.trigger,
        changeCount: row.changeCount,
        status:
          row.eligibleAt.getTime() <= sampledAt.getTime() ? 'due' : 'waiting',
        firstChangedAt: row.firstChangedAt.toISOString(),
        lastChangedAt: row.lastChangedAt.toISOString(),
        eligibleAt: row.eligibleAt.toISOString(),
        remainingWaitMs: Math.max(
          0,
          row.eligibleAt.getTime() - sampledAt.getTime(),
        ),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      total: numberValue(countRow?.count),
      page,
      limit,
    };
  }

  /**
   * Page-centric compilation log: for each source page, the most recent
   * per-page compilation record within an optional time window. Answers
   * "was this page compiled recently, and did it succeed?" without forcing the
   * operator to locate the owning run first. Backed entirely by existing
   * knowledge_space_compile_run_pages rows (no new table).
   */
  async listPageCompilationLog(input: {
    workspaceId: string;
    spaceIds: string[];
    enforceSpaceScope: boolean;
    statuses?: string[];
    search?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
    includeSensitiveErrors?: boolean;
  }) {
    const page = Math.max(input.page ?? 1, 1);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    if (input.enforceSpaceScope && input.spaceIds.length === 0) {
      return { items: [], total: 0, page, limit };
    }

    let base = this.db
      .selectFrom('knowledgeSpaceCompileRunPages as runPage')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'runPage.runId')
      .innerJoin('spaces as space', (join) =>
        join
          .onRef('space.id', '=', 'run.spaceId')
          .onRef('space.workspaceId', '=', 'run.workspaceId')
          .on('space.deletedAt', 'is', null),
      )
      .leftJoin('pages as page', 'page.id', 'runPage.sourcePageId')
      .where('runPage.workspaceId', '=', input.workspaceId);
    if (input.spaceIds.length > 0) {
      base = base.where('run.spaceId', 'in', input.spaceIds);
    }
    const fromDate = parseTimestamp(input.from);
    if (fromDate) {
      base = base.where('runPage.updatedAt', '>=', fromDate);
    }
    const toDate = parseTimestamp(input.to);
    if (toDate) {
      base = base.where('runPage.updatedAt', '<=', toDate);
    }
    const search = input.search?.trim();
    if (search) {
      base = base.where((eb) =>
        eb.or([
          eb('page.title', 'ilike', `%${search}%`),
          eb('page.slugId', 'ilike', `%${search}%`),
        ]),
      );
    }

    const latest = base
      .select([
        'runPage.id as runPageId',
        'runPage.runId',
        'runPage.sourcePageId',
        'run.spaceId',
        'space.name as spaceName',
        'page.title',
        'page.slugId',
        'runPage.status',
        'runPage.imageStatus',
        'runPage.mergeStatus',
        'runPage.expectedImageCount',
        'runPage.succeededImageCount',
        'runPage.failedImageCount',
        'runPage.skippedImageCount',
        'runPage.errorCode',
        'runPage.errorMessage',
        'runPage.queuedAt',
        'runPage.startedAt',
        'runPage.finishedAt',
        'runPage.updatedAt',
      ])
      .distinctOn('runPage.sourcePageId')
      .orderBy('runPage.sourcePageId')
      .orderBy('runPage.updatedAt', 'desc')
      .orderBy('runPage.id', 'desc');

    let current = this.db.selectFrom(latest.as('latest'));
    if (input.statuses?.length) {
      current = current.where('latest.status', 'in', input.statuses);
    }

    const [countRow, rows] = await Promise.all([
      current.select((eb) => eb.fn.countAll().as('count')).executeTakeFirst(),
      current
        .selectAll()
        .orderBy('latest.updatedAt', 'desc')
        .orderBy('latest.sourcePageId', 'asc')
        .offset((page - 1) * limit)
        .limit(limit)
        .execute(),
    ]);

    const runPageIds = rows.map((row) => row.runPageId);
    const imageFailures =
      runPageIds.length === 0
        ? []
        : await this.db
            .selectFrom('knowledgeSpaceCompileRunImages')
            .select(['runPageId', 'failureClass'])
            .select((eb) => eb.fn.countAll().as('count'))
            .where('runPageId', 'in', runPageIds)
            .where('status', '=', 'failed')
            .groupBy(['runPageId', 'failureClass'])
            .execute();
    const imageFailuresByPage = new Map<
      string,
      { retryableExhausted: number; permanent: number }
    >();
    for (const row of imageFailures) {
      const current = imageFailuresByPage.get(row.runPageId) ?? {
        retryableExhausted: 0,
        permanent: 0,
      };
      if (row.failureClass === 'retryable_exhausted') {
        current.retryableExhausted += numberValue(row.count);
      } else if (row.failureClass === 'permanent') {
        current.permanent += numberValue(row.count);
      }
      imageFailuresByPage.set(row.runPageId, current);
    }

    return {
      items: rows.map((row) => {
        const startedMs = row.startedAt?.getTime() ?? null;
        const finishedMs = row.finishedAt?.getTime() ?? null;
        return {
          runPageId: row.runPageId,
          runId: row.runId,
          sourcePageId: row.sourcePageId,
          spaceId: row.spaceId,
          spaceName: row.spaceName,
          title: row.title ?? '',
          slugId: row.slugId ?? null,
          status: row.status,
          imageStatus: row.imageStatus,
          mergeStatus: row.mergeStatus,
          expectedImageCount: row.expectedImageCount,
          succeededImageCount: row.succeededImageCount,
          failedImageCount: row.failedImageCount,
          skippedImageCount: row.skippedImageCount,
          errorCode: row.errorCode,
          errorCategory: classifyRunPageError(row.errorCode),
          errorSummary: row.errorCode
            ? safeCompilationErrorMessage(row.errorCode)
            : null,
          ...(input.includeSensitiveErrors && row.errorMessage
            ? { errorDetail: sanitizeRunPageErrorDetail(row.errorMessage) }
            : {}),
          queuedAt: isoDate(row.queuedAt),
          startedAt: isoDate(row.startedAt),
          finishedAt: isoDate(row.finishedAt),
          // No per-page duration column exists; approximate from timestamps.
          durationMs:
            startedMs !== null && finishedMs !== null
              ? Math.max(0, finishedMs - startedMs)
              : null,
          lastCompiledAt: isoDate(row.finishedAt ?? row.updatedAt),
          updatedAt: row.updatedAt.toISOString(),
          imageFailures: imageFailuresByPage.get(row.runPageId) ?? {
            retryableExhausted: 0,
            permanent: 0,
          },
        };
      }),
      total: numberValue(countRow?.count),
      page,
      limit,
    };
  }

  async findRetryableFailedPageIds(input: {
    workspaceId: string;
    sourcePageIds: string[];
  }): Promise<string[]> {
    if (input.sourcePageIds.length === 0) return [];
    const sourcePageIds = [...new Set(input.sourcePageIds)];

    const latest = this.db
      .selectFrom('knowledgeSpaceCompileRunPages as runPage')
      .select(['runPage.sourcePageId', 'runPage.status', 'runPage.mergeStatus'])
      .where('runPage.workspaceId', '=', input.workspaceId)
      .where('runPage.sourcePageId', 'in', sourcePageIds)
      .distinctOn('runPage.sourcePageId')
      .orderBy('runPage.sourcePageId')
      .orderBy('runPage.updatedAt', 'desc')
      .orderBy('runPage.id', 'desc');

    const rows = await this.db
      .selectFrom(latest.as('latest'))
      .select('latest.sourcePageId')
      .where((eb) =>
        eb.or([
          eb('latest.status', '=', 'failed'),
          eb('latest.mergeStatus', '=', 'failed'),
        ]),
      )
      .execute();

    return [...new Set(rows.map((row) => row.sourcePageId))];
  }

  async findWorkspaceSpaceIds(input: {
    workspaceId: string;
    requestedSpaceIds?: string[];
  }): Promise<string[]> {
    const requestedSpaceIds = [...new Set(input.requestedSpaceIds ?? [])];
    if (requestedSpaceIds.length > 100) {
      throw new BadRequestException(
        'At most 100 Spaces can be inspected at once.',
      );
    }
    let query = this.db
      .selectFrom('spaces')
      .select('id')
      .where('workspaceId', '=', input.workspaceId)
      .where('deletedAt', 'is', null);
    if (requestedSpaceIds.length > 0) {
      query = query.where('id', 'in', requestedSpaceIds);
    }
    const rows = await query.execute();
    return rows.map((row) => row.id);
  }

  private async findOperationalQueueSnapshots(): Promise<KnowledgeOperationalQueueSnapshots> {
    const sampledAt = new Date().toISOString();
    const [space, image] = await Promise.all([
      this.knowledgeSpaceQueue
        ? this.findQueueSnapshot(this.knowledgeSpaceQueue, sampledAt)
        : Promise.resolve({ ...emptyQueueCounts(), sampledAt }),
      this.findQueueSnapshot(this.knowledgeImageQueue, sampledAt),
    ]);
    return { space, image };
  }

  private async safeGetWorkers(
    queue: Queue | undefined,
  ): Promise<Array<{ name?: string }> | undefined> {
    if (!queue) return undefined;
    try {
      return (await queue.getWorkers()) as Array<{ name?: string }>;
    } catch {
      return undefined;
    }
  }

  private async findQueueSnapshot(
    queue: Queue,
    sampledAt: string,
  ): Promise<KnowledgeQueueSnapshot> {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'waiting-children',
      'paused',
      'failed',
      'completed',
    );
    return {
      waiting: Number(counts.waiting ?? 0),
      active: Number(counts.active ?? 0),
      delayed: Number(counts.delayed ?? 0),
      prioritized: Number(counts.prioritized ?? 0),
      waitingChildren: Number(counts['waiting-children'] ?? 0),
      paused: Number(counts.paused ?? 0),
      failed: Number(counts.failed ?? 0),
      completed: Number(counts.completed ?? 0),
      sampledAt,
    };
  }
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function parseTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function classifyRunPageError(
  errorCode: string | null,
):
  | 'budget_timeout'
  | 'provider'
  | 'publication'
  | 'infrastructure'
  | 'other'
  | null {
  if (!errorCode) return null;
  const normalized = errorCode.toLowerCase();
  if (normalized === 'page_timeout') return 'budget_timeout';
  if (
    normalized.includes('provider') ||
    normalized.includes('llm') ||
    normalized === 'rate_limited' ||
    normalized === 'invalid_output'
  ) {
    return 'provider';
  }
  if (
    normalized.includes('publication') ||
    normalized.includes('import') ||
    normalized.includes('merge')
  ) {
    return 'publication';
  }
  if (
    normalized.includes('storage') ||
    normalized.includes('database') ||
    normalized.includes('embedding') ||
    normalized.includes('job')
  ) {
    return 'infrastructure';
  }
  return 'other';
}

export function sanitizeRunPageErrorDetail(value: string): string {
  return value
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .slice(0, 500);
}

function emptyQueueCounts(): KnowledgeQueueCounts {
  return {
    waiting: 0,
    active: 0,
    delayed: 0,
    prioritized: 0,
    waitingChildren: 0,
    paused: 0,
    failed: 0,
    completed: 0,
  };
}

function safeCompilationErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'configuration_error':
      return 'Knowledge compiler is not configured.';
    case 'invalid_output':
      return 'Knowledge compiler returned invalid output.';
    case 'rate_limited':
      return 'Knowledge compiler provider rate limit was exceeded.';
    case 'timeout':
      return 'Knowledge compiler provider timed out.';
    case 'provider_error':
      return 'Knowledge compiler provider request failed.';
    case 'embedding_not_configured':
      return 'Knowledge embedding provider is not configured correctly.';
    case 'embedding_rate_limited':
      return 'Knowledge embedding provider rate limit was reached.';
    case 'embedding_timeout':
      return 'Knowledge embedding request timed out.';
    case 'embedding_provider_error':
      return 'Knowledge embedding provider request failed.';
    case 'embedding_invalid_vector':
      return 'Knowledge embedding provider returned an invalid vector.';
    case 'embedding_invalid_input':
      return 'Knowledge chunk is empty and cannot be embedded.';
    case 'embedding_input_too_large':
      return 'Knowledge chunk exceeds the embedding provider input limit.';
    case 'source_changed':
      return 'Knowledge source changed during compilation.';
    case 'empty_source':
      return 'Knowledge source is empty.';
    case 'source_unavailable':
      return 'Knowledge source page is unavailable for compilation.';
    case 'validation_failed':
      return 'Knowledge compiler output failed validation.';
    default:
      return 'Knowledge compilation failed.';
  }
}
