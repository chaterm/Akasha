import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { Job, JobState, Queue } from 'bullmq';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import {
  KnowledgeQueryAuditRepo,
  KnowledgeRetrievalAuditSummary,
} from '@akasha/db/repos/llm-wiki/knowledge-query-audit.repo';
import {
  KnowledgeQuarantineRepo,
  KnowledgeQuarantinedArtifactDiagnostic,
} from '@akasha/db/repos/llm-wiki/knowledge-quarantine.repo';
import { QueueJob, QueueName } from '../../../integrations/queue/constants';
import { KnowledgeCompileJobResult } from '../types/knowledge-queue.types';
import {
  KnowledgeQualityReport,
  KnowledgeQualityService,
} from './knowledge-quality.service';
import { KnowledgeSpaceCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-space-compilation.repo';
import {
  KNOWLEDGE_IMAGE_WORKER_OPTIONS,
  KNOWLEDGE_SPACE_WORKER_OPTIONS,
  KNOWLEDGE_WORKER_SETTINGS,
} from './knowledge-worker-settings';
import { getKnowledgeWorkerEventSnapshot } from './knowledge-worker-observability';

const KNOWLEDGE_JOB_NAMES = new Set<string>([
  QueueJob.PAGE_CONTENT_UPDATED,
  QueueJob.KNOWLEDGE_COMPILE_IMAGE,
  QueueJob.KNOWLEDGE_REBUILD_EMBEDDINGS,
  QueueJob.KNOWLEDGE_MARK_SOURCES_STALE,
  QueueJob.KNOWLEDGE_REINDEX_ACCESS,
]);

const JOB_STATES: JobState[] = [
  'waiting',
  'delayed',
  'active',
  'failed',
  'completed',
];

type CountRow = {
  sourcePageId: string;
  count: string | number | bigint;
};

type SourceStaleRow = {
  sourcePageId: string;
  staleAt: Date | null;
};

type CompiledAtRow = {
  sourcePageId: string;
  compiledAt: Date;
};

type AccessPolicyRow = {
  sourcePageId: string;
  updatedAt: Date;
  staleAt: Date | null;
};

type AccessPolicyStats = {
  lastAccessPolicyIndexedAt: Date | null;
  staleAccessPolicyCount: number;
};

export type KnowledgeDiagnosticsPage = {
  pageId: string;
  slugId: string;
  title: string;
  spaceId: string;
  spaceName: string;
  spaceSlug: string;
  updatedAt: Date;
  deletedAt: Date | null;
  textLength: number;
  knowledgeSourceCount: number;
  staleSourceCount: number;
  oldestStaleSourceAt: Date | null;
  knowledgePageSourceCount: number;
  knowledgeChunkCount: number;
  missingEmbeddingChunkCount: number;
  lastCompiledAt: Date | null;
  lastAccessPolicyIndexedAt: Date | null;
  staleAccessPolicyCount: number;
  compileStatus: KnowledgePageCompileStatus;
  compileStage: KnowledgePageCompileStage | null;
  compileAttemptCount: number;
  compileErrorCode: string | null;
  compileErrorMessage: string | null;
  lastSucceededAt: Date | null;
  servingLastSuccessfulVersion: boolean;
};

export type KnowledgePageCompileStatus =
  | 'not_started'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'failed';

export type KnowledgePageCompileStage =
  | 'queued'
  | 'read_source'
  | 'image_enrichment'
  | 'analysis'
  | 'generation'
  | 'merge'
  | 'validation'
  | 'import'
  | 'completed';

export type KnowledgeDiagnosticsJob = {
  id: string;
  name: string;
  state: string;
  workspaceId?: string;
  spaceId?: string;
  pageIds: string[];
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  returnValue?: KnowledgeCompileJobResult;
};

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

export type KnowledgeQueueSnapshots = {
  text: KnowledgeQueueSnapshot;
  image: KnowledgeQueueSnapshot;
};

export type KnowledgeOperationalQueueSnapshots = {
  space: KnowledgeQueueSnapshot;
  image: KnowledgeQueueSnapshot;
};

export type KnowledgeCompilationStageProgress = {
  expected: number;
  succeeded: number;
  failed: number;
  skipped: number;
  pending: number;
  waiting: number;
  lastAttemptError?: string;
};

export type KnowledgeCompileRunProgress = {
  runId: string;
  spaceId: string;
  spaceName: string;
  status: string;
  mode?: 'update' | 'force';
  phase?: string;
  generation?: number;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  progress: {
    text: KnowledgeCompilationStageProgress;
    image: KnowledgeCompilationStageProgress;
    merge: KnowledgeCompilationStageProgress;
  };
};

export type KnowledgeCompileStatus = {
  spaceId: string;
  status:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'superseded';
  jobId: string;
  lastRunId: string;
  durationMs: number | null;
  sourceCount: number;
  succeededPageCount?: number;
  failedPageCount?: number;
  skippedPageCount?: number;
  importedArtifactCount: number;
  quarantinedArtifactCount: number;
  failureReason?: string;
  updatedAt?: number;
};

type DurableSpaceRunDiagnostic = {
  id: string;
  workspaceId: string;
  spaceId: string;
  status: string;
  expectedPageCount: number;
  succeededPageCount: number;
  failedPageCount: number;
  skippedPageCount: number;
  importedArtifactCount: number;
  quarantinedArtifactCount: number;
  aggregateJobId: string | null;
  errorCode: string | null;
  spaceName?: string;
  mode?: string;
  phase?: string;
  knowledgeGeneration?: number;
  createdAt?: Date;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
};

type DurableCompileRunRow = {
  id: string;
  spaceId: string;
  spaceName: string;
  status: string;
  mode: string;
  phase: string;
  knowledgeGeneration: number;
  expectedPageCount: number;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

type DurableCompileRunPageRow = {
  runId: string;
  sourcePageId: string;
  status: string;
  expectedImageCount: number;
  succeededImageCount: number;
  failedImageCount: number;
  skippedImageCount: number;
  imageStatus: string;
  mergeStatus: string;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: Date;
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
    @InjectQueue(QueueName.KNOWLEDGE_TEXT_QUEUE)
    private readonly knowledgeTextQueue: Queue,
    @InjectQueue(QueueName.KNOWLEDGE_IMAGE_QUEUE)
    private readonly knowledgeImageQueue: Queue,
    private readonly quality: KnowledgeQualityService,
    private readonly queryAuditRepo: KnowledgeQueryAuditRepo,
    private readonly quarantineRepo: KnowledgeQuarantineRepo,
    private readonly spaceRunRepo: KnowledgeSpaceCompilationRepo,
    @InjectQueue(QueueName.KNOWLEDGE_SPACE_QUEUE)
    private readonly knowledgeSpaceQueue?: Queue,
  ) {}

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
              sql<number>`count(*) filter (where run.status in ('compiling', 'aggregating') and run.phase in ('text', 'initial_aggregate', 'image_merge', 'final_aggregate'))`.as(
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
              sql<Date>`min(run.space_job_queued_at) filter (where run.status = 'queued' and run.phase in ('text', 'initial_aggregate', 'image_merge', 'final_aggregate'))`.as(
                'oldestSpaceJobQueuedAt',
              ),
              sql<number>`count(*) filter (where run.status = 'queued' and run.space_job_id is not null and run.space_job_dispatched_at is null)`.as(
                'spaceUnacknowledged',
              ),
              sql<number>`count(*) filter (where run.execution_lease_expires_at < now() and run.status in ('compiling', 'aggregating'))`.as(
                'expiredExecutionLeases',
              ),
              sql<number>`count(*) filter (where run.space_job_recovery_count > 0 and run.status in ('queued', 'compiling', 'aggregate_pending', 'aggregating'))`.as(
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
              sql<number>`count(*) filter (where rp.status = 'failed' and rp.error_code = 'page_timeout')`.as(
                'budgetTimeout',
              ),
              sql<number>`count(*) filter (where rp.status = 'failed' and rp.error_code <> 'page_timeout' and (rp.error_code ilike '%provider%' or rp.error_code ilike '%llm%' or rp.error_code in ('rate_limited', 'invalid_output')))`.as(
                'provider',
              ),
              sql<number>`count(*) filter (where rp.status = 'failed' and (rp.error_code ilike '%publication%' or rp.error_code ilike '%import%' or rp.error_code ilike '%merge%'))`.as(
                'publication',
              ),
              sql<number>`count(*) filter (where rp.status = 'failed' and (rp.error_code ilike '%storage%' or rp.error_code ilike '%database%' or rp.error_code ilike '%job%' or rp.error_code ilike '%embedding%'))`.as(
                'infrastructure',
              ),
              sql<number>`count(*) filter (where rp.status = 'failed')`.as(
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
              sql<number>`count(*) filter (where rp.merge_status not in ('not_required', 'waiting_images'))`.as(
                'expectedMergeCount',
              ),
              sql<number>`count(*) filter (where rp.merge_status = 'succeeded')`.as(
                'succeededMergeCount',
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
            },
            merge: {
              expected: numberValue(progress?.expectedMergeCount),
              succeeded: numberValue(progress?.succeededMergeCount),
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

  async findRetryableFailedPageIds(input: {
    workspaceId: string;
    sourcePageIds: string[];
  }): Promise<string[]> {
    if (input.sourcePageIds.length === 0) return [];
    const sourcePageIds = [...new Set(input.sourcePageIds)];

    const rows = await this.db
      .selectFrom('knowledgeCompilationAttempts')
      .select('sourcePageId')
      .where('workspaceId', '=', input.workspaceId)
      .where('sourcePageId', 'in', sourcePageIds)
      .where('status', '=', 'failed')
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

  async getWorkspaceDiagnostics(input: {
    workspaceId: string;
    spaceIds?: string[];
    enforceSpaceScope?: boolean;
    canViewGlobalQueues?: boolean;
    includeDetailedDiagnostics?: boolean;
    statuses?: KnowledgePageCompileStatus[];
    stages?: KnowledgePageCompileStage[];
    limit?: number;
  }): Promise<{
    pages: KnowledgeDiagnosticsPage[];
    jobs: KnowledgeDiagnosticsJob[];
    queueCounts: KnowledgeQueueCounts;
    compileStatuses: KnowledgeCompileStatus[];
    canViewGlobalQueues: boolean;
    queueSnapshots?: KnowledgeQueueSnapshots;
    compileRuns: KnowledgeCompileRunProgress[];
    retrieval: KnowledgeRetrievalAuditSummary;
    quarantines: KnowledgeQuarantinedArtifactDiagnostic[];
    quality: KnowledgeQualityReport;
  }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const includeDetailedDiagnostics =
      input.includeDetailedDiagnostics !== false;
    const pages = includeDetailedDiagnostics
      ? await this.findRecentPages({
          workspaceId: input.workspaceId,
          spaceIds: input.spaceIds ?? [],
          enforceSpaceScope: Boolean(input.enforceSpaceScope),
          statuses: input.statuses ?? [],
          stages: input.stages ?? [],
          limit,
        })
      : [];
    const pageIds = pages.map((page) => page.pageId);
    const [
      sourceCounts,
      staleSourceCounts,
      oldestStaleSourceAts,
      pageSourceCounts,
      chunkCounts,
      missingEmbeddingCounts,
      lastCompiledAts,
      accessPolicyStats,
      queueSnapshots,
      jobs,
      durableRuns,
    ] = await Promise.all([
      this.countSources(input.workspaceId, pageIds, false),
      this.countSources(input.workspaceId, pageIds, true),
      this.findOldestStaleSourceAtBySourcePage(input.workspaceId, pageIds),
      this.countBySourcePage(
        'knowledgePageSources',
        input.workspaceId,
        pageIds,
      ),
      this.countBySourcePage(
        'knowledgeChunkSources',
        input.workspaceId,
        pageIds,
      ),
      this.countMissingEmbeddingsBySourcePage(input.workspaceId, pageIds),
      this.findLastCompiledAtBySourcePage(input.workspaceId, pageIds),
      this.findAccessPolicyStatsBySourcePage(input.workspaceId, pageIds),
      this.findQueueSnapshotsIfAllowed(Boolean(input.canViewGlobalQueues)),
      includeDetailedDiagnostics
        ? this.findKnowledgeJobs({
            workspaceId: input.workspaceId,
            spaceIds: input.spaceIds,
            enforceSpaceScope: Boolean(input.enforceSpaceScope),
            limit,
          })
        : Promise.resolve([]),
      this.findLatestDurableRuns({
        workspaceId: input.workspaceId,
        spaceIds: input.spaceIds,
        enforceSpaceScope: Boolean(input.enforceSpaceScope),
        limit,
      }),
    ]);
    const diagnosticPages = pages.map((page) => {
      const policyStats = accessPolicyStats.get(page.pageId);
      const lastCompiledAt = lastCompiledAts.get(page.pageId) ?? null;

      return {
        ...page,
        knowledgeSourceCount: sourceCounts.get(page.pageId) ?? 0,
        staleSourceCount: staleSourceCounts.get(page.pageId) ?? 0,
        oldestStaleSourceAt: oldestStaleSourceAts.get(page.pageId) ?? null,
        knowledgePageSourceCount: pageSourceCounts.get(page.pageId) ?? 0,
        knowledgeChunkCount: chunkCounts.get(page.pageId) ?? 0,
        missingEmbeddingChunkCount:
          missingEmbeddingCounts.get(page.pageId) ?? 0,
        lastCompiledAt,
        lastAccessPolicyIndexedAt:
          policyStats?.lastAccessPolicyIndexedAt ?? null,
        staleAccessPolicyCount: policyStats?.staleAccessPolicyCount ?? 0,
        servingLastSuccessfulVersion:
          page.compileStatus !== 'succeeded' &&
          (page.servingLastSuccessfulVersion || Boolean(lastCompiledAt)),
      };
    });

    const durableStatuses = buildCompileStatusesFromRuns(durableRuns);
    const durableSpaceIds = new Set(
      durableStatuses.map((status) => status.spaceId),
    );
    const legacyJobStatuses = buildCompileStatusesFromJobs(jobs).filter(
      (status) => !durableSpaceIds.has(status.spaceId),
    );
    const compileRuns = await this.findDurableCompileRunProgress({
      workspaceId: input.workspaceId,
      runs: durableRuns as DurableSpaceRunDiagnostic[],
      limit,
    });
    const queueCounts = queueSnapshots?.text ?? emptyQueueCounts();
    const includeWorkspaceWideDiagnostics =
      includeDetailedDiagnostics && Boolean(input.canViewGlobalQueues);
    const retrieval = includeWorkspaceWideDiagnostics
      ? await this.queryAuditRepo.summarizeWorkspace({
          workspaceId: input.workspaceId,
          limit,
        })
      : emptyRetrievalSummary();
    const quarantines = includeWorkspaceWideDiagnostics
      ? await this.quarantineRepo.findRecentByWorkspace({
          workspaceId: input.workspaceId,
          limit,
        })
      : [];

    return {
      pages: diagnosticPages,
      jobs,
      queueCounts,
      compileStatuses: [...durableStatuses, ...legacyJobStatuses].sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      ),
      canViewGlobalQueues: Boolean(input.canViewGlobalQueues),
      ...(queueSnapshots ? { queueSnapshots } : {}),
      compileRuns,
      retrieval,
      quarantines,
      quality: this.quality.evaluate({ pages: diagnosticPages }),
    };
  }

  private async findRecentPages(input: {
    workspaceId: string;
    spaceIds: string[];
    enforceSpaceScope: boolean;
    statuses: KnowledgePageCompileStatus[];
    stages: KnowledgePageCompileStage[];
    limit: number;
  }): Promise<
    Omit<
      KnowledgeDiagnosticsPage,
      | 'knowledgeSourceCount'
      | 'staleSourceCount'
      | 'oldestStaleSourceAt'
      | 'knowledgePageSourceCount'
      | 'knowledgeChunkCount'
      | 'missingEmbeddingChunkCount'
      | 'lastCompiledAt'
      | 'lastAccessPolicyIndexedAt'
      | 'staleAccessPolicyCount'
    >[]
  > {
    if (input.enforceSpaceScope && input.spaceIds.length === 0) return [];
    let query = this.db
      .selectFrom('pages as p')
      .innerJoin('spaces as s', 's.id', 'p.spaceId')
      .leftJoin('knowledgeCompilationAttempts as ca', 'ca.sourcePageId', 'p.id')
      .select([
        'p.id as pageId',
        'p.slugId',
        'p.title',
        'p.spaceId',
        's.name as spaceName',
        's.slug as spaceSlug',
        'p.updatedAt',
        'p.deletedAt',
        'ca.status as compileAttemptStatus',
        'ca.stage as compileAttemptStage',
        'ca.attemptCount as compileAttemptCount',
        'ca.errorCode as compileAttemptErrorCode',
        'ca.errorMessage as compileAttemptErrorMessage',
        'ca.lastSuccessfulSourceVersion as lastSuccessfulSourceVersion',
        'ca.lastSucceededAt as compileAttemptLastSucceededAt',
      ])
      .select((eb) => eb.fn('length', ['p.textContent']).as('textLength'))
      .where('p.workspaceId', '=', input.workspaceId)
      .orderBy('p.updatedAt', 'desc')
      .limit(input.limit);

    if (input.spaceIds.length > 0) {
      query = query.where('p.spaceId', 'in', input.spaceIds);
    }
    if (input.statuses.length > 0) {
      const includeNotStarted = input.statuses.includes('not_started');
      const attemptStatuses = input.statuses.filter(
        (
          status,
        ): status is Exclude<KnowledgePageCompileStatus, 'not_started'> =>
          status !== 'not_started',
      );
      query = query.where((eb) =>
        eb.or([
          ...(includeNotStarted ? [eb('ca.id', 'is', null)] : []),
          ...(attemptStatuses.length > 0
            ? [eb('ca.status', 'in', attemptStatuses)]
            : []),
        ]),
      );
    }
    if (input.stages.length > 0) {
      query = query.where('ca.stage', 'in', input.stages);
    }

    const rows = await query.execute();
    return rows.map((row) => ({
      pageId: row.pageId,
      slugId: row.slugId,
      title: row.title,
      spaceId: row.spaceId,
      spaceName: row.spaceName,
      spaceSlug: row.spaceSlug,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      textLength: Number(row.textLength ?? 0),
      ...buildPageCompilationDiagnostics({
        status: row.compileAttemptStatus,
        stage: row.compileAttemptStage,
        attemptCount: row.compileAttemptCount,
        errorCode: row.compileAttemptErrorCode,
        errorMessage: row.compileAttemptErrorMessage,
        lastSuccessfulSourceVersion: row.lastSuccessfulSourceVersion,
        lastSucceededAt: row.compileAttemptLastSucceededAt,
      }),
    }));
  }

  private async countSources(
    workspaceId: string,
    sourcePageIds: string[],
    staleOnly: boolean,
  ): Promise<Map<string, number>> {
    if (sourcePageIds.length === 0) return new Map();

    let query = this.db
      .selectFrom('knowledgeSources')
      .select(['sourcePageId'])
      .select((eb) => eb.fn.count('id').as('count'))
      .where('workspaceId', '=', workspaceId)
      .where('sourcePageId', 'in', sourcePageIds)
      .groupBy('sourcePageId');

    if (staleOnly) {
      query = query.where('staleAt', 'is not', null);
    }

    return rowsToCountMap(await query.execute());
  }

  private async countBySourcePage(
    table: 'knowledgePageSources' | 'knowledgeChunkSources',
    workspaceId: string,
    sourcePageIds: string[],
  ): Promise<Map<string, number>> {
    if (sourcePageIds.length === 0) return new Map();

    const rows = await this.db
      .selectFrom(table)
      .select(['sourcePageId'])
      .select((eb) => eb.fn.countAll().as('count'))
      .where('workspaceId', '=', workspaceId)
      .where('sourcePageId', 'in', sourcePageIds)
      .groupBy('sourcePageId')
      .execute();

    return rowsToCountMap(rows);
  }

  private async findOldestStaleSourceAtBySourcePage(
    workspaceId: string,
    sourcePageIds: string[],
  ): Promise<Map<string, Date>> {
    if (sourcePageIds.length === 0) return new Map();

    const rows = await this.db
      .selectFrom('knowledgeSources')
      .select(['sourcePageId', 'staleAt'])
      .where('workspaceId', '=', workspaceId)
      .where('sourcePageId', 'in', sourcePageIds)
      .where('staleAt', 'is not', null)
      .execute();

    const oldestBySource = new Map<string, Date>();
    for (const row of rows as SourceStaleRow[]) {
      if (!row.staleAt) continue;

      const current = oldestBySource.get(row.sourcePageId);
      if (!current || row.staleAt.getTime() < current.getTime()) {
        oldestBySource.set(row.sourcePageId, row.staleAt);
      }
    }
    return oldestBySource;
  }

  private async findLastCompiledAtBySourcePage(
    workspaceId: string,
    sourcePageIds: string[],
  ): Promise<Map<string, Date>> {
    if (sourcePageIds.length === 0) return new Map();

    const rows = await this.db
      .selectFrom('knowledgePageSources')
      .innerJoin(
        'knowledgePages',
        'knowledgePageSources.knowledgePageId',
        'knowledgePages.id',
      )
      .select([
        'knowledgePageSources.sourcePageId as sourcePageId',
        'knowledgePages.compiledAt as compiledAt',
      ])
      .where('knowledgePageSources.workspaceId', '=', workspaceId)
      .where('knowledgePageSources.sourcePageId', 'in', sourcePageIds)
      .where('knowledgePages.staleAt', 'is', null)
      .execute();

    const latestBySource = new Map<string, Date>();
    for (const row of rows as CompiledAtRow[]) {
      const current = latestBySource.get(row.sourcePageId);
      if (!current || row.compiledAt.getTime() > current.getTime()) {
        latestBySource.set(row.sourcePageId, row.compiledAt);
      }
    }
    return latestBySource;
  }

  private async countMissingEmbeddingsBySourcePage(
    workspaceId: string,
    sourcePageIds: string[],
  ): Promise<Map<string, number>> {
    if (sourcePageIds.length === 0) return new Map();

    const rows = await this.db
      .selectFrom('knowledgeChunkSources')
      .innerJoin(
        'knowledgeChunks',
        'knowledgeChunkSources.chunkId',
        'knowledgeChunks.id',
      )
      .select('knowledgeChunkSources.sourcePageId')
      .where('knowledgeChunkSources.workspaceId', '=', workspaceId)
      .where('knowledgeChunkSources.sourcePageId', 'in', sourcePageIds)
      .where('knowledgeChunks.embedding', 'is', null)
      .execute();

    const counts = new Map<string, number>();
    for (const row of rows as Array<{ sourcePageId: string }>) {
      counts.set(row.sourcePageId, (counts.get(row.sourcePageId) ?? 0) + 1);
    }
    return counts;
  }

  private async findAccessPolicyStatsBySourcePage(
    workspaceId: string,
    sourcePageIds: string[],
  ): Promise<Map<string, AccessPolicyStats>> {
    if (sourcePageIds.length === 0) return new Map();

    const rows = await this.db
      .selectFrom('knowledgeSourceAccessPolicy')
      .select(['sourcePageId', 'updatedAt', 'staleAt'])
      .where('workspaceId', '=', workspaceId)
      .where('sourcePageId', 'in', sourcePageIds)
      .execute();
    const statsBySource = new Map<string, AccessPolicyStats>();

    for (const row of rows as AccessPolicyRow[]) {
      const current = statsBySource.get(row.sourcePageId) ?? {
        lastAccessPolicyIndexedAt: null,
        staleAccessPolicyCount: 0,
      };

      if (
        !current.lastAccessPolicyIndexedAt ||
        row.updatedAt.getTime() > current.lastAccessPolicyIndexedAt.getTime()
      ) {
        current.lastAccessPolicyIndexedAt = row.updatedAt;
      }
      if (row.staleAt) {
        current.staleAccessPolicyCount += 1;
      }
      statsBySource.set(row.sourcePageId, current);
    }

    return statsBySource;
  }

  private async findKnowledgeJobs(input: {
    workspaceId: string;
    spaceIds?: string[];
    enforceSpaceScope: boolean;
    limit: number;
  }): Promise<KnowledgeDiagnosticsJob[]> {
    if (input.enforceSpaceScope && (input.spaceIds?.length ?? 0) === 0) {
      return [];
    }
    const jobs = (
      await Promise.all(
        [this.knowledgeTextQueue, this.knowledgeImageQueue].map((queue) =>
          queue.getJobs(JOB_STATES, 0, input.limit * 4, false),
        ),
      )
    ).flat();
    const allowedSpaceIds = new Set(input.spaceIds ?? []);
    const rows = await Promise.all(
      jobs
        .filter((job) => KNOWLEDGE_JOB_NAMES.has(job.name))
        .filter((job) => job.data?.workspaceId === input.workspaceId)
        .filter(
          (job) =>
            !input.enforceSpaceScope || allowedSpaceIds.has(job.data?.spaceId),
        )
        .sort(
          (a, b) =>
            (b.finishedOn ?? b.processedOn ?? b.timestamp ?? 0) -
            (a.finishedOn ?? a.processedOn ?? a.timestamp ?? 0),
        )
        .slice(0, input.limit)
        .map((job) => this.toDiagnosticsJob(job)),
    );

    return rows;
  }

  private async findQueueSnapshotsIfAllowed(
    canViewGlobalQueues: boolean,
  ): Promise<KnowledgeQueueSnapshots | undefined> {
    return canViewGlobalQueues ? this.findQueueSnapshots() : undefined;
  }

  private async findQueueSnapshots(): Promise<KnowledgeQueueSnapshots> {
    const sampledAt = new Date().toISOString();
    const [text, image] = await Promise.all([
      this.findQueueSnapshot(this.knowledgeTextQueue, sampledAt),
      this.findQueueSnapshot(this.knowledgeImageQueue, sampledAt),
    ]);
    return { text, image };
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

  private async findDurableCompileRunProgress(input: {
    workspaceId: string;
    runs: DurableSpaceRunDiagnostic[];
    limit: number;
  }): Promise<KnowledgeCompileRunProgress[]> {
    const latestRuns = latestRunPerSpace(input.runs).slice(0, input.limit);
    if (latestRuns.length === 0) return [];
    const runIds = latestRuns.map((run) => run.id);
    const pages = await this.db
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select([
        'runId',
        'sourcePageId',
        'status',
        'expectedImageCount',
        'succeededImageCount',
        'failedImageCount',
        'skippedImageCount',
        'imageStatus',
        'mergeStatus',
        'errorCode',
        'errorMessage',
        'updatedAt',
      ])
      .where('workspaceId', '=', input.workspaceId)
      .where('runId', 'in', runIds)
      .execute();
    return buildCompileRunProgress(
      latestRuns.map((run) => ({
        ...run,
        spaceName: run.spaceName ?? '',
        mode: run.mode ?? 'incremental',
        phase: run.phase ?? 'text',
        knowledgeGeneration: run.knowledgeGeneration ?? 0,
        createdAt: run.createdAt ?? run.queuedAt,
      })),
      pages as DurableCompileRunPageRow[],
    );
  }

  private async findLatestDurableRuns(input: {
    workspaceId: string;
    spaceIds?: string[];
    enforceSpaceScope: boolean;
    limit: number;
  }): Promise<DurableSpaceRunDiagnostic[]> {
    if (input.enforceSpaceScope && (input.spaceIds?.length ?? 0) === 0) {
      return [];
    }
    let latestPerSpace = this.db
      .selectFrom('knowledgeSpaceCompileRuns as run')
      .innerJoin('spaces as space', (join) =>
        join
          .onRef('space.id', '=', 'run.spaceId')
          .onRef('space.workspaceId', '=', 'run.workspaceId'),
      )
      .select([
        'run.id',
        'run.workspaceId',
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
        'run.importedArtifactCount',
        'run.quarantinedArtifactCount',
        'run.aggregateJobId',
        'run.errorCode',
        'run.createdAt',
        'run.queuedAt',
        'run.startedAt',
        'run.finishedAt',
        'run.updatedAt',
      ])
      .where('run.workspaceId', '=', input.workspaceId)
      .where('space.deletedAt', 'is', null)
      .distinctOn('run.spaceId')
      .orderBy('run.spaceId', 'asc')
      .orderBy('run.createdAt', 'desc');
    if (input.spaceIds?.length) {
      latestPerSpace = latestPerSpace.where(
        'run.spaceId',
        'in',
        input.spaceIds,
      );
    }
    return this.db
      .selectFrom(latestPerSpace.as('latestRun'))
      .selectAll()
      .orderBy('createdAt', 'desc')
      .limit(input.limit)
      .execute() as Promise<DurableSpaceRunDiagnostic[]>;
  }

  private async toDiagnosticsJob(job: Job): Promise<KnowledgeDiagnosticsJob> {
    const state = await job.getState();
    return {
      id: String(job.id),
      name: job.name,
      state,
      workspaceId: job.data?.workspaceId,
      spaceId: job.data?.spaceId,
      pageIds: Array.isArray(job.data?.pageIds)
        ? job.data.pageIds
        : Array.isArray(job.data?.sourcePageIds)
          ? job.data.sourcePageIds
          : [],
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason:
        state === 'failed'
          ? sanitizeKnowledgeFailureReason(job.failedReason)
          : undefined,
      returnValue: toCompileJobResult(
        (job as Job<unknown, unknown>).returnvalue,
      ),
    };
  }
}

function rowsToCountMap(rows: CountRow[]): Map<string, number> {
  return new Map(rows.map((row) => [row.sourcePageId, Number(row.count ?? 0)]));
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

function sanitizeRunPageErrorDetail(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function buildCompileRunProgress(
  runs: DurableCompileRunRow[],
  pages: DurableCompileRunPageRow[],
): KnowledgeCompileRunProgress[] {
  const pagesByRun = new Map<string, DurableCompileRunPageRow[]>();
  for (const page of pages) {
    const runPages = pagesByRun.get(page.runId) ?? [];
    runPages.push(page);
    pagesByRun.set(page.runId, runPages);
  }

  return runs.map((run) => {
    const runPages = pagesByRun.get(run.id) ?? [];
    const text = buildTextProgress(run.expectedPageCount, runPages);
    const image = buildImageProgress(runPages);
    const merge = buildMergeProgress(runPages);
    return {
      runId: run.id,
      spaceId: run.spaceId,
      spaceName: run.spaceName,
      status: run.status,
      mode:
        run.mode === 'force_rebuild'
          ? ('force' as const)
          : run.mode === 'incremental'
            ? ('update' as const)
            : undefined,
      phase: run.phase,
      generation: Number(run.knowledgeGeneration ?? 0),
      createdAt: run.createdAt?.toISOString(),
      updatedAt: run.updatedAt?.toISOString(),
      ...(run.finishedAt ? { completedAt: run.finishedAt.toISOString() } : {}),
      progress: { text, image, merge },
    };
  });
}

function buildTextProgress(
  expectedPageCount: number,
  pages: DurableCompileRunPageRow[],
): KnowledgeCompilationStageProgress {
  const succeeded = countStatus(pages, 'status', ['succeeded']);
  const failed = countStatus(pages, 'status', ['failed']);
  const skipped = countStatus(pages, 'status', ['skipped']);
  const expected = Math.max(Number(expectedPageCount ?? 0), pages.length);
  const pending = Math.max(0, expected - succeeded - failed - skipped);
  const waiting = countStatus(pages, 'status', ['pending']);
  const errorCode = findLatestErrorCode(
    pages,
    (page) => page.status === 'failed',
  );
  return {
    expected,
    succeeded,
    failed,
    skipped,
    pending,
    waiting,
    ...(errorCode
      ? { lastAttemptError: safeCompilationErrorMessage(errorCode) }
      : {}),
  };
}

function buildImageProgress(
  pages: DurableCompileRunPageRow[],
): KnowledgeCompilationStageProgress {
  const expected = sum(pages, 'expectedImageCount');
  const succeeded = sum(pages, 'succeededImageCount');
  const failed = sum(pages, 'failedImageCount');
  const skipped = sum(pages, 'skippedImageCount');
  const pending = Math.max(0, expected - succeeded - failed - skipped);
  const waiting = pages
    .filter((page) => page.imageStatus === 'pending')
    .reduce((total, page) => total + Number(page.expectedImageCount ?? 0), 0);
  const hasFailure = pages.some(
    (page) => page.imageStatus === 'failed' || page.imageStatus === 'partial',
  );
  return {
    expected,
    succeeded,
    failed,
    skipped,
    pending,
    waiting,
    ...(hasFailure
      ? { lastAttemptError: 'Image processing completed with failures.' }
      : {}),
  };
}

function buildMergeProgress(
  pages: DurableCompileRunPageRow[],
): KnowledgeCompilationStageProgress {
  const mergePages = pages.filter(
    (page) => page.mergeStatus !== 'not_required',
  );
  const succeeded = countStatus(mergePages, 'mergeStatus', ['succeeded']);
  const failed = countStatus(mergePages, 'mergeStatus', ['failed']);
  const skipped = countStatus(mergePages, 'mergeStatus', ['skipped']);
  const pending = countStatus(mergePages, 'mergeStatus', [
    'waiting_images',
    'pending',
    'queued',
    'running',
  ]);
  const waiting = countStatus(mergePages, 'mergeStatus', [
    'waiting_images',
    'pending',
  ]);
  return {
    expected: mergePages.length,
    succeeded,
    failed,
    skipped,
    pending,
    waiting,
    ...(failed > 0
      ? { lastAttemptError: 'Image knowledge merge failed.' }
      : {}),
  };
}

function countStatus(
  pages: DurableCompileRunPageRow[],
  field: 'status' | 'imageStatus' | 'mergeStatus',
  values: string[],
): number {
  const allowed = new Set(values);
  return pages.filter((page) => allowed.has(page[field])).length;
}

function sum(
  pages: DurableCompileRunPageRow[],
  field:
    | 'expectedImageCount'
    | 'succeededImageCount'
    | 'failedImageCount'
    | 'skippedImageCount',
): number {
  return pages.reduce((total, page) => total + Number(page[field] ?? 0), 0);
}

function findLatestErrorCode(
  pages: DurableCompileRunPageRow[],
  include: (page: DurableCompileRunPageRow) => boolean,
): string | undefined {
  return [...pages]
    .filter((page) => include(page) && Boolean(page.errorCode))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
    ?.errorCode?.slice(0, 80);
}

function latestRunPerSpace<T extends DurableSpaceRunDiagnostic>(
  runs: T[],
): T[] {
  const latest = new Map<string, T>();
  for (const run of [...runs].sort(
    (a, b) =>
      (b.createdAt ?? b.queuedAt).getTime() -
      (a.createdAt ?? a.queuedAt).getTime(),
  )) {
    if (!latest.has(run.spaceId)) latest.set(run.spaceId, run);
  }
  return [...latest.values()];
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

function emptyRetrievalSummary(): KnowledgeRetrievalAuditSummary {
  return {
    sampleCount: 0,
    zeroHitRate: 0,
    embeddingFallbackRate: 0,
    accessPolicyFallbackRate: 0,
    averageAuthorizedCandidateCount: 0,
    averageFilteredCandidateCount: 0,
  };
}

export function buildPageCompilationDiagnostics(input?: {
  status?: string | null;
  stage?: string | null;
  attemptCount?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  lastSuccessfulSourceVersion?: string | null;
  lastSucceededAt?: Date | null;
  hasActiveArtifact?: boolean;
}): Pick<
  KnowledgeDiagnosticsPage,
  | 'compileStatus'
  | 'compileStage'
  | 'compileAttemptCount'
  | 'compileErrorCode'
  | 'compileErrorMessage'
  | 'lastSucceededAt'
  | 'servingLastSuccessfulVersion'
> {
  const status = toPageCompileStatus(input?.status);
  const errorCode = input?.errorCode ?? null;
  return {
    compileStatus: status,
    compileStage: toPageCompileStage(input?.stage),
    compileAttemptCount: Number(input?.attemptCount ?? 0),
    compileErrorCode: errorCode,
    compileErrorMessage: errorCode
      ? safeCompilationErrorMessage(errorCode)
      : null,
    lastSucceededAt: input?.lastSucceededAt ?? null,
    servingLastSuccessfulVersion:
      status !== 'succeeded' &&
      status !== 'skipped' &&
      (Boolean(input?.lastSuccessfulSourceVersion) ||
        Boolean(input?.hasActiveArtifact)),
  };
}

function toPageCompileStatus(
  value: string | null | undefined,
): KnowledgePageCompileStatus {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'skipped' ||
    value === 'failed'
  ) {
    return value;
  }
  return 'not_started';
}

function toPageCompileStage(
  value: string | null | undefined,
): KnowledgePageCompileStage | null {
  if (
    value === 'queued' ||
    value === 'read_source' ||
    value === 'image_enrichment' ||
    value === 'analysis' ||
    value === 'generation' ||
    value === 'merge' ||
    value === 'validation' ||
    value === 'import' ||
    value === 'completed'
  ) {
    return value;
  }
  return null;
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

export function buildCompileStatusesFromJobs(
  jobs: KnowledgeDiagnosticsJob[],
): KnowledgeCompileStatus[] {
  const latestBySpaceId = new Map<string, KnowledgeDiagnosticsJob>();

  for (const job of [...jobs].sort(
    (a, b) => jobUpdatedAt(b) - jobUpdatedAt(a),
  )) {
    if (job.name !== QueueJob.KNOWLEDGE_COMPILE_SPACE || !job.spaceId) {
      continue;
    }
    if (!latestBySpaceId.has(job.spaceId)) {
      latestBySpaceId.set(job.spaceId, job);
    }
  }

  return [...latestBySpaceId.values()].map((job) => ({
    spaceId: job.spaceId as string,
    status: toCompileStatus(job.state),
    jobId: job.id,
    lastRunId: job.returnValue?.compilerRunId ?? job.id,
    durationMs: job.returnValue?.durationMs ?? null,
    sourceCount: job.returnValue?.sourceCount ?? 0,
    importedArtifactCount: job.returnValue?.importedArtifactCount ?? 0,
    quarantinedArtifactCount: job.returnValue?.quarantinedArtifactCount ?? 0,
    failureReason:
      job.state === 'failed'
        ? sanitizeKnowledgeFailureReason(job.failedReason)
        : undefined,
    updatedAt: jobUpdatedAt(job) || undefined,
  }));
}

export function buildCompileStatusesFromRuns(
  runs: DurableSpaceRunDiagnostic[],
): KnowledgeCompileStatus[] {
  return latestRunPerSpace(runs).map((run) => ({
    spaceId: run.spaceId,
    status: toDurableCompileStatus(run.status),
    jobId: run.aggregateJobId ?? run.id,
    lastRunId: run.id,
    durationMs: run.finishedAt
      ? Math.max(0, run.finishedAt.getTime() - run.queuedAt.getTime())
      : null,
    sourceCount: run.expectedPageCount,
    succeededPageCount: run.succeededPageCount,
    failedPageCount: run.failedPageCount,
    skippedPageCount: run.skippedPageCount,
    importedArtifactCount: run.importedArtifactCount,
    quarantinedArtifactCount: run.quarantinedArtifactCount,
    failureReason:
      run.status === 'failed' && run.errorCode
        ? safeCompilationErrorMessage(run.errorCode)
        : undefined,
    updatedAt: run.updatedAt.getTime(),
  }));
}

function toDurableCompileStatus(
  status: string,
): KnowledgeCompileStatus['status'] {
  if (status === 'succeeded' || status === 'partial' || status === 'failed') {
    return status;
  }
  if (status === 'superseded') return 'superseded';
  if (status === 'queued') return 'queued';
  return 'running';
}

function toCompileStatus(state: string): KnowledgeCompileStatus['status'] {
  if (state === 'active') return 'running';
  if (state === 'completed') return 'succeeded';
  if (state === 'failed') return 'failed';
  return 'queued';
}

function jobUpdatedAt(job: KnowledgeDiagnosticsJob): number {
  return job.finishedOn ?? job.processedOn ?? job.timestamp ?? 0;
}

function sanitizeKnowledgeFailureReason(
  reason: string | undefined,
): string | undefined {
  if (!reason) return undefined;

  const errorName = reason.match(/^([A-Za-z]+(?:Error)?):/)?.[1] ?? 'Error';
  return `Compile job failed: ${errorName}`;
}

function toCompileJobResult(
  value: unknown,
): KnowledgeCompileJobResult | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.type !== 'compile-space' && value.type !== 'compile-pages') ||
    value.status !== 'succeeded'
  ) {
    return undefined;
  }

  return {
    type: value.type,
    status: 'succeeded',
    workspaceId: readString(value.workspaceId),
    spaceId: readString(value.spaceId),
    compilerRunId: readString(value.compilerRunId),
    sourceCount: readNumber(value.sourceCount),
    importedArtifactCount: readNumber(value.importedArtifactCount),
    quarantinedArtifactCount: readNumber(value.quarantinedArtifactCount),
    durationMs: readNumber(value.durationMs),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}
