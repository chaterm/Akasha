import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectKysely } from 'nestjs-kysely';
import { Job, JobState, Queue } from 'bullmq';
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

const KNOWLEDGE_JOB_NAMES = new Set<string>([
  QueueJob.PAGE_CONTENT_UPDATED,
  QueueJob.KNOWLEDGE_COMPILE_SPACE,
  QueueJob.KNOWLEDGE_COMPILE_PAGES,
  QueueJob.KNOWLEDGE_AGGREGATE_SPACE,
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
  | 'failed';

export type KnowledgePageCompileStage =
  | 'queued'
  | 'read_source'
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

export type KnowledgeCompileStatus = {
  spaceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';
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
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
};

@Injectable()
export class KnowledgeDiagnosticsService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.AI_QUEUE) private readonly aiQueue: Queue,
    private readonly quality: KnowledgeQualityService,
    private readonly queryAuditRepo: KnowledgeQueryAuditRepo,
    private readonly quarantineRepo: KnowledgeQuarantineRepo,
    private readonly spaceRunRepo: KnowledgeSpaceCompilationRepo,
  ) {}

  async getWorkspaceDiagnostics(input: {
    workspaceId: string;
    spaceIds?: string[];
    statuses?: KnowledgePageCompileStatus[];
    stages?: KnowledgePageCompileStage[];
    limit?: number;
  }): Promise<{
    pages: KnowledgeDiagnosticsPage[];
    jobs: KnowledgeDiagnosticsJob[];
    compileStatuses: KnowledgeCompileStatus[];
    retrieval: KnowledgeRetrievalAuditSummary;
    quarantines: KnowledgeQuarantinedArtifactDiagnostic[];
    quality: KnowledgeQualityReport;
  }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const pages = await this.findRecentPages({
      workspaceId: input.workspaceId,
      spaceIds: input.spaceIds ?? [],
      statuses: input.statuses ?? [],
      stages: input.stages ?? [],
      limit,
    });
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
      this.findKnowledgeJobs(input.workspaceId, limit),
      this.spaceRunRepo.findRecentRuns({
        workspaceId: input.workspaceId,
        spaceIds: input.spaceIds,
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

    return {
      pages: diagnosticPages,
      jobs,
      compileStatuses: [...durableStatuses, ...legacyJobStatuses].sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      ),
      retrieval: await this.queryAuditRepo.summarizeWorkspace({
        workspaceId: input.workspaceId,
        limit,
      }),
      quarantines: await this.quarantineRepo.findRecentByWorkspace({
        workspaceId: input.workspaceId,
        limit,
      }),
      quality: this.quality.evaluate({ pages: diagnosticPages }),
    };
  }

  private async findRecentPages(input: {
    workspaceId: string;
    spaceIds: string[];
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

  private async findKnowledgeJobs(
    workspaceId: string,
    limit: number,
  ): Promise<KnowledgeDiagnosticsJob[]> {
    const jobs = await this.aiQueue.getJobs(JOB_STATES, 0, limit * 4, false);
    const rows = await Promise.all(
      jobs
        .filter((job) => KNOWLEDGE_JOB_NAMES.has(job.name))
        .filter((job) => job.data?.workspaceId === workspaceId)
        .slice(0, limit)
        .map((job) => this.toDiagnosticsJob(job)),
    );

    return rows;
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
      failedReason: sanitizeKnowledgeFailureReason(job.failedReason),
      returnValue: toCompileJobResult(
        (job as Job<unknown, unknown>).returnvalue,
      ),
    };
  }
}

function rowsToCountMap(rows: CountRow[]): Map<string, number> {
  return new Map(rows.map((row) => [row.sourcePageId, Number(row.count ?? 0)]));
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
  const latestBySpace = new Map<string, DurableSpaceRunDiagnostic>();
  for (const run of [...runs].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  )) {
    if (!latestBySpace.has(run.spaceId)) latestBySpace.set(run.spaceId, run);
  }
  return [...latestBySpace.values()].map((run) => ({
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
