import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@akasha/db/types/db';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
import { sql } from 'kysely';
import {
  readRunPipelineWork,
  reconcileRunPipelineInTransaction,
} from './knowledge-run-pipeline';
import {
  PAGE_ATTEMPT_BUDGET,
  MERGE_ATTEMPT_BUDGET,
  MERGE_TRANSPORT_RECOVERY_BUDGET,
} from './knowledge-compilation-budgets';
import type {
  KnowledgeSpaceCompileRunPageImageStatus,
  KnowledgeSpaceCompileRunPageMergeStatus,
  KnowledgeSpaceCompileRunPageStatus,
  KnowledgeSpaceCompileRunPhase,
  KnowledgeSpaceCompileRunStatus,
} from './knowledge-space-compilation.repo';
import {
  parseTargetSourcePageIds,
  reconcileFollowUpTargetScope,
} from './knowledge-run-scope';

export type SpaceJobPhase = 'text' | 'finalize';

export interface SpaceExecutionLease {
  runId: string;
  knowledgeGeneration: number;
  jobPhase: SpaceJobPhase;
  spaceJobSequence: number;
  spaceJobId: string;
  executionToken: string;
}

export interface SpaceJobReservation extends Omit<
  SpaceExecutionLease,
  'executionToken'
> {}

/**
 * Immutable execution identity for an independent Page Merge job. Unlike the
 * space-level merge, a Page Merge does not hold a SpaceExecutionLease; its fence
 * lives entirely on the RunPage row (merge_job_id + merge_execution_token) plus
 * the frozen source identity, and is validated against the current Space/Run
 * generation on every heartbeat, failure settlement and publication.
 */
export interface PageMergeExecutionFence {
  workspaceId: string;
  spaceId: string;
  runId: string;
  runPageId: string;
  sourcePageId: string;
  knowledgeGeneration: number;
  mergeJobId: string;
  mergeExecutionToken: string;
  sourceVersion: string;
  sourceContentHash: string;
}

/** Deterministic reservation prior to claim; token is minted at claim time. */
export interface PageMergeReservation {
  workspaceId: string;
  spaceId: string;
  runId: string;
  runPageId: string;
  sourcePageId: string;
  knowledgeGeneration: number;
  mergeJobId: string;
}

export interface PageMergeImageSnapshot {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  fileSize: number | null;
  attachmentVersion: string;
  altText?: string;
}

export interface RunPageBindingPlan {
  sourcePageId: string;
  expectedSourceVersion: string;
  expectedSourceContentHash: string;
  expectedImageCount: number;
  succeededImageCount?: number;
  failedImageCount?: number;
  skippedImageCount?: number;
  status: KnowledgeSpaceCompileRunPageStatus;
  imageStatus: KnowledgeSpaceCompileRunPageImageStatus;
  mergeStatus: KnowledgeSpaceCompileRunPageMergeStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  /**
   * Binding-time cache/reuse hint. It may omit images that were still pending
   * at binding, so merge publication must derive its identity from frozen
   * RunImage extraction ids instead.
   */
  targetEffectiveKnowledgeHash?: string | null;
  reused?: boolean;
  qualityStatus?: 'normal' | 'degraded' | 'partial_image';
}

export interface RunImageInitializationPlan {
  sourcePageId: string;
  attachmentId: string;
  imageOrdinal: number;
  fileName: string;
  mimeType: string;
  fileSize?: number | string | null;
  altText?: string | null;
  expectedAttachmentVersion: Date | string;
  status?: 'pending' | 'succeeded' | 'skipped';
  extractionId?: string | null;
}

export interface PageMergeRecoveryObservation {
  runPageId: string;
  runId: string;
  knowledgeGeneration: number;
  mergeJobId: string;
  mergeStatus: string;
  mergeExecutionToken: string | null;
  mergeProcessingExpiresAt: Date | null;
  mergeDispatchedAt: Date | null;
  mergeRedisRecoveryCount: number;
  observedAt: Date;
  queuedDispatchedBefore: Date;
}

const NONTERMINAL_RUN_STATUSES: KnowledgeSpaceCompileRunStatus[] = [
  'queued',
  'compiling',
  'aggregating',
];
const TEXT_PHASES: KnowledgeSpaceCompileRunPhase[] = ['text'];
const FINALIZE_PHASES: KnowledgeSpaceCompileRunPhase[] = ['finalizing'];

// A Page Merge may run while the Run is still compiling text or images, or in
// the dedicated image_merge phase. It is never dispatched in finalizing: by
// then every merge must already be terminal.
const PAGE_MERGE_RUN_PHASES: KnowledgeSpaceCompileRunPhase[] = [
  'text',
  'images',
  'image_merge',
];
const PAGE_MERGE_RUN_STATUSES: KnowledgeSpaceCompileRunStatus[] = [
  'queued',
  'compiling',
];

export function runPhaseToJobPhase(
  phase: KnowledgeSpaceCompileRunPhase,
): SpaceJobPhase {
  if (TEXT_PHASES.includes(phase)) return 'text';
  if (FINALIZE_PHASES.includes(phase)) return 'finalize';
  throw new Error(`Run phase ${phase} does not use the Space queue.`);
}

export function buildSpaceJobId(
  runId: string,
  phase: SpaceJobPhase,
  sequence: number,
): string {
  const name =
    phase === 'text' ? 'knowledge-space-text' : 'knowledge-space-finalize';
  return `${name}__${runId}__${phase}__${sequence}`;
}

export function buildPageMergeJobId(
  runId: string,
  runPageId: string,
  generation: number,
): string {
  return ['knowledge-page-merge', runId, runPageId, String(generation)].join(
    '__',
  );
}

@Injectable()
export class KnowledgeSpaceExecutionRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findLeasedRun(lease: SpaceExecutionLease) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .selectAll()
      .$call((query) => this.whereLease(query, lease))
      .where('phase', 'in', this.phasesFor(lease.jobPhase))
      .where('status', 'in', NONTERMINAL_RUN_STATUSES)
      .executeTakeFirst();
  }

  async isLeaseActive(lease: SpaceExecutionLease): Promise<boolean> {
    return Boolean(await this.findLeasedRun(lease));
  }

  async findPendingTextPages(lease: SpaceExecutionLease) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRunPages as page')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'page.runId')
      .select([
        'page.sourcePageId',
        'page.bindingStatus',
        'page.expectedSourceVersion',
        'page.expectedSourceContentHash',
        'page.createdAt',
      ])
      .where('run.id', '=', lease.runId)
      .where('run.knowledgeGeneration', '=', lease.knowledgeGeneration)
      .where('run.spaceJobSequence', '=', lease.spaceJobSequence)
      .where('run.spaceJobId', '=', lease.spaceJobId)
      .where('run.executionToken', '=', lease.executionToken)
      .where('run.phase', '=', 'text')
      .where('run.status', 'in', NONTERMINAL_RUN_STATUSES)
      .where('page.status', 'in', ['pending', 'queued', 'running'])
      .orderBy('page.createdAt', 'asc')
      .orderBy('page.sourcePageId', 'asc')
      .limit(1)
      .execute();
  }

  /**
   * Claims the next text barrier row under the Space execution lease. Exact
   * source identity is deliberately absent until the worker exports the page.
   * A recovered binding row is claimable again because the lease token fences
   * the eventual bind CAS.
   */
  async claimNextTextPage(lease: SpaceExecutionLease) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.phase !== 'text') return undefined;
      const page = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select([
          'id',
          'sourcePageId',
          'bindingStatus',
          'attemptCount',
          'indexMode',
          'expectedSourceVersion',
          'expectedSourceContentHash',
          'createdAt',
        ])
        .where('runId', '=', lease.runId)
        .where('status', 'in', ['pending', 'queued', 'running'])
        .orderBy('createdAt', 'asc')
        .orderBy('sourcePageId', 'asc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (!page) return undefined;
      const unbound = page.bindingStatus === 'unbound';
      const claimed = await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          status: 'running',
          startedAt: new Date(),
          attemptCount: page.attemptCount + 1,
          ...(unbound ? { bindingStatus: 'binding' as const } : {}),
          updatedAt: new Date(),
        })
        .where('id', '=', page.id)
        .$if(unbound, (query) => query.where('bindingStatus', '=', 'unbound'))
        .returning('id')
        .executeTakeFirst();
      if (!claimed) return undefined;
      return {
        ...page,
        attemptCount: page.attemptCount + 1,
        ...(unbound ? { bindingStatus: 'binding' as const } : {}),
      };
    });
  }

  async findSpaceRecoveryCandidates(input: {
    leaseExpiredBefore: Date;
    queuedDispatchedBefore: Date;
    limit?: number;
  }) {
    const rows = await this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .select([
        'id',
        'knowledgeGeneration',
        'phase',
        'spaceJobSequence',
        'spaceJobId',
        'spaceJobRecoveryCount',
        'executionLeaseExpiresAt',
        'status',
      ])
      .where('spaceJobId', 'is not', null)
      .where('phase', 'in', ['text', 'finalizing'])
      .where((expression) =>
        expression.or([
          expression.and([
            expression('status', 'in', ['compiling', 'aggregating']),
            expression(
              'executionLeaseExpiresAt',
              '<',
              input.leaseExpiredBefore,
            ),
          ]),
          expression.and([
            expression('status', '=', 'queued'),
            expression('spaceJobDispatchedAt', 'is not', null),
            expression(
              'spaceJobDispatchedAt',
              '<',
              input.queuedDispatchedBefore,
            ),
          ]),
        ]),
      )
      .orderBy('updatedAt', 'asc')
      .orderBy('id', 'asc')
      .limit(input.limit ?? 100)
      .execute();
    return rows.flatMap((run) => {
      try {
        return [
          {
            runId: run.id,
            knowledgeGeneration: run.knowledgeGeneration,
            jobPhase: runPhaseToJobPhase(
              run.phase as KnowledgeSpaceCompileRunPhase,
            ),
            spaceJobSequence: run.spaceJobSequence,
            spaceJobId: run.spaceJobId!,
            spaceJobRecoveryCount: run.spaceJobRecoveryCount,
            executionLeaseExpiresAt: run.executionLeaseExpiresAt,
            status: run.status,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  async isLeaseActiveForPublication(
    lease: SpaceExecutionLease,
    input: {
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
    },
    trx: KyselyTransaction,
  ): Promise<boolean> {
    const run = await this.lockLeasedRun(trx, lease);
    if (!run || run.phase !== 'text') return false;
    const page = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select('id')
      .where('runId', '=', lease.runId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('bindingStatus', '=', 'bound')
      .where('expectedSourceVersion', '=', input.sourceVersion)
      .where('expectedSourceContentHash', '=', input.sourceContentHash)
      .forUpdate()
      .executeTakeFirst();
    return Boolean(page);
  }

  // ===== Page Merge outbox + execution fence =====

  /**
   * Fair, cross-space Page Merge reservation. Candidate runs are read without a
   * lock, then each run is reserved in its own short transaction so no single
   * transaction locks more than one Space/Run. At most one page per run is
   * reserved, enforcing the single-outstanding-merge-per-run rule.
   */
  async reservePageMergesFairly(
    input: { runLimit?: number } = {},
  ): Promise<PageMergeReservation[]> {
    const runs = await this.db
      .selectFrom('knowledgeSpaceCompileRuns as run')
      .select(['run.id'])
      .where('run.phase', 'in', PAGE_MERGE_RUN_PHASES)
      .where('run.status', 'in', PAGE_MERGE_RUN_STATUSES)
      .where((expression) =>
        expression.exists(
          expression
            .selectFrom('knowledgeSpaceCompileRunPages as page')
            .select('page.id')
            .whereRef('page.runId', '=', 'run.id')
            .where('page.mergeStatus', '=', 'pending'),
        ),
      )
      .where((expression) =>
        expression.not(
          expression.exists(
            expression
              .selectFrom('knowledgeSpaceCompileRunPages as busy')
              .select('busy.id')
              .whereRef('busy.runId', '=', 'run.id')
              .where('busy.mergeStatus', 'in', ['queued', 'running']),
          ),
        ),
      )
      .orderBy('run.updatedAt', 'asc')
      .orderBy('run.id', 'asc')
      .limit(input.runLimit ?? 100)
      .execute();
    const reservations: PageMergeReservation[] = [];
    for (const run of runs) {
      const reserved = await this.reservePageMergeForRun(run.id);
      if (reserved) reservations.push(reserved);
    }
    return reservations;
  }

  private async reservePageMergeForRun(
    runId: string,
  ): Promise<PageMergeReservation | undefined> {
    return executeTx(this.db, async (trx) => {
      const scope = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .select(['workspaceId', 'spaceId'])
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!scope) return undefined;
      const space = await trx
        .selectFrom('spaces')
        .select('knowledgeGeneration')
        .where('id', '=', scope.spaceId)
        .where('workspaceId', '=', scope.workspaceId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!space) return undefined;
      const run = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .select(['id', 'workspaceId', 'spaceId', 'knowledgeGeneration'])
        .where('id', '=', runId)
        .where('knowledgeGeneration', '=', space.knowledgeGeneration)
        .where('phase', 'in', PAGE_MERGE_RUN_PHASES)
        .where('status', 'in', PAGE_MERGE_RUN_STATUSES)
        .forUpdate()
        .executeTakeFirst();
      if (!run) return undefined;
      // Single outstanding merge per run: bail if one is already in flight.
      const busy = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select('id')
        .where('runId', '=', runId)
        .where('mergeStatus', 'in', ['queued', 'running'])
        .limit(1)
        .executeTakeFirst();
      if (busy) return undefined;
      const page = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select(['id', 'sourcePageId'])
        .where('runId', '=', runId)
        .where('mergeStatus', '=', 'pending')
        .where('bindingStatus', '=', 'bound')
        .orderBy('createdAt', 'asc')
        .orderBy('sourcePageId', 'asc')
        .orderBy('id', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!page) return undefined;
      const mergeJobId = buildPageMergeJobId(
        run.id,
        page.id,
        run.knowledgeGeneration,
      );
      const reserved = await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          mergeStatus: 'queued',
          mergeJobId,
          mergeDispatchedAt: null,
          updatedAt: new Date(),
        })
        .where('id', '=', page.id)
        .where('mergeStatus', '=', 'pending')
        .returning('id')
        .executeTakeFirst();
      if (!reserved) return undefined;
      return {
        workspaceId: run.workspaceId,
        spaceId: run.spaceId,
        runId: run.id,
        runPageId: page.id,
        sourcePageId: page.sourcePageId,
        knowledgeGeneration: run.knowledgeGeneration,
        mergeJobId,
      };
    });
  }

  async findUndispatchedPageMerges(limit = 500) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRunPages as page')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'page.runId')
      .select([
        'page.id as runPageId',
        'page.runId',
        'page.workspaceId',
        'page.spaceId',
        'page.sourcePageId',
        'page.mergeJobId',
        'run.knowledgeGeneration',
      ])
      .where('page.mergeStatus', '=', 'queued')
      .where('page.mergeJobId', 'is not', null)
      .where('page.mergeDispatchedAt', 'is', null)
      .where('run.phase', 'in', PAGE_MERGE_RUN_PHASES)
      .where('run.status', 'in', PAGE_MERGE_RUN_STATUSES)
      .orderBy('run.updatedAt', 'asc')
      .orderBy('page.createdAt', 'asc')
      .orderBy('page.id', 'asc')
      .limit(limit)
      .execute();
  }

  async markPageMergeDispatched(input: {
    runPageId: string;
    runId: string;
    knowledgeGeneration: number;
    mergeJobId: string;
  }): Promise<boolean> {
    const updated = await this.db
      .updateTable('knowledgeSpaceCompileRunPages')
      .set({ mergeDispatchedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', input.runPageId)
      .where('runId', '=', input.runId)
      .where('mergeStatus', '=', 'queued')
      .where('mergeJobId', '=', input.mergeJobId)
      .where('mergeDispatchedAt', 'is', null)
      .where(
        'runId',
        'in',
        this.db
          .selectFrom('knowledgeSpaceCompileRuns')
          .select('id')
          .where('id', '=', input.runId)
          .where('knowledgeGeneration', '=', input.knowledgeGeneration)
          .where('phase', 'in', PAGE_MERGE_RUN_PHASES)
          .where('status', 'in', PAGE_MERGE_RUN_STATUSES),
      )
      .returning('id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  /**
   * Claim a dispatched Page Merge for execution. Locks Space -> Run -> RunPage,
   * validates the deterministic job identity and frozen source identity, then
   * atomically mints a fresh execution token and marks the page running. Returns
   * the immutable fence plus the frozen image snapshot, or undefined if the job
   * is stale / already claimed / superseded.
   */
  async claimPageMerge(input: {
    runId: string;
    runPageId: string;
    knowledgeGeneration: number;
    mergeJobId: string;
    workerId: string;
    processingExpiresAt: Date;
  }): Promise<
    | (PageMergeExecutionFence & {
        mergeAttemptCount: number;
        expectedExtractionIds: string[];
        images: PageMergeImageSnapshot[];
      })
    | undefined
  > {
    const claimed = await executeTx(this.db, async (trx) => {
      const locked = await this.lockPageMergeRunPage(trx, input);
      if (!locked) return undefined;
      const { run, page } = locked;
      if (page.mergeStatus !== 'queued') return undefined;
      if (page.mergeJobId !== input.mergeJobId) return undefined;
      if (page.bindingStatus !== 'bound') return undefined;
      // Transport recovery and duplicate delivery must never mint a fourth
      // execution, even if an exhausted page was left queued by an old worker.
      if (page.mergeAttemptCount >= MERGE_ATTEMPT_BUDGET) {
        await this.failPageMergeInTransaction(trx, {
          runId: run.id,
          runPageId: page.id,
          errorCode: 'merge_job_attempts_exhausted',
          errorMessage: 'Page merge exhausted its execution attempt budget.',
        });
        return undefined;
      }
      if (
        page.expectedSourceVersion === null ||
        page.expectedSourceContentHash === null
      ) {
        return undefined;
      }
      // Single-outstanding-merge safety: no other page of this run is running.
      const otherRunning = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select('id')
        .where('runId', '=', input.runId)
        .where('id', '!=', page.id)
        .where('mergeStatus', 'in', ['queued', 'running'])
        .limit(1)
        .executeTakeFirst();
      if (otherRunning) return undefined;
      const mergeExecutionToken = randomUUID();
      const now = new Date();
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          mergeStatus: 'running',
          mergeExecutionToken,
          mergeProcessingExpiresAt: input.processingExpiresAt,
          mergeWorkerId: input.workerId,
          mergeHeartbeatAt: now,
          mergeAttemptCount: page.mergeAttemptCount + 1,
          updatedAt: now,
        })
        .where('id', '=', page.id)
        .where('mergeStatus', '=', 'queued')
        .where('mergeJobId', '=', input.mergeJobId)
        .returning('id')
        .executeTakeFirst();
      if (!updated) return undefined;
      return {
        workspaceId: run.workspaceId,
        spaceId: run.spaceId,
        runId: run.id,
        runPageId: page.id,
        sourcePageId: page.sourcePageId,
        knowledgeGeneration: run.knowledgeGeneration,
        mergeJobId: input.mergeJobId,
        mergeExecutionToken,
        sourceVersion: page.expectedSourceVersion,
        sourceContentHash: page.expectedSourceContentHash,
        mergeAttemptCount: page.mergeAttemptCount + 1,
      };
    });
    if (!claimed) return undefined;
    try {
      const snapshot = await this.loadPageMergeImageSnapshot(claimed.runPageId);
      return { ...claimed, ...snapshot };
    } catch (error) {
      // A transient read failure after claim must release the token for the
      // same BullMQ job's delayed retry, not leave a running row that retries
      // can only noop against.
      await this.finishPageMerge(claimed, {
        status: 'failed',
        retryable: true,
        errorCode: 'merge_snapshot_read_failed',
        errorMessage: 'Unable to load the frozen image snapshot.',
      });
      throw error;
    }
  }

  /**
   * Locks Space -> Run -> RunPage for a Page Merge in the canonical order and
   * validates generation + run activity. Returns the locked run/page rows, or
   * undefined if the space generation drifted or the run is no longer active in
   * a merge-eligible phase.
   */
  private async lockPageMergeRunPage(
    trx: KyselyTransaction,
    input: { runId: string; runPageId: string; knowledgeGeneration: number },
  ) {
    const scope = await trx
      .selectFrom('knowledgeSpaceCompileRuns')
      .select(['workspaceId', 'spaceId'])
      .where('id', '=', input.runId)
      .executeTakeFirst();
    if (!scope) return undefined;
    const space = await trx
      .selectFrom('spaces')
      .select('knowledgeGeneration')
      .where('id', '=', scope.spaceId)
      .where('workspaceId', '=', scope.workspaceId)
      .where('deletedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!space || space.knowledgeGeneration !== input.knowledgeGeneration) {
      return undefined;
    }
    const run = await trx
      .selectFrom('knowledgeSpaceCompileRuns')
      .select([
        'id',
        'workspaceId',
        'spaceId',
        'knowledgeGeneration',
        'phase',
        'rerunRequested',
        'followUpTargetSourcePageIds',
      ])
      .where('id', '=', input.runId)
      .where('knowledgeGeneration', '=', input.knowledgeGeneration)
      .where('phase', 'in', PAGE_MERGE_RUN_PHASES)
      .where('status', 'in', PAGE_MERGE_RUN_STATUSES)
      .forUpdate()
      .executeTakeFirst();
    if (!run) return undefined;
    const page = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select([
        'id',
        'sourcePageId',
        'bindingStatus',
        'mergeStatus',
        'mergeJobId',
        'mergeExecutionToken',
        'mergeAttemptCount',
        'mergeRedisRecoveryCount',
        'mergeProcessingExpiresAt',
        'mergeDispatchedAt',
        'expectedSourceVersion',
        'expectedSourceContentHash',
      ])
      .where('runId', '=', input.runId)
      .where('id', '=', input.runPageId)
      .forUpdate()
      .executeTakeFirst();
    if (!page) return undefined;
    return { run, page };
  }

  private async loadPageMergeImageSnapshot(runPageId: string): Promise<{
    expectedExtractionIds: string[];
    images: PageMergeImageSnapshot[];
  }> {
    const images = await this.db
      .selectFrom('knowledgeSpaceCompileRunImages')
      .select([
        'attachmentId',
        'imageOrdinal',
        'fileName',
        'mimeType',
        'fileSize',
        'altText',
        'expectedAttachmentVersion',
        'status',
        'extractionId',
      ])
      .where('runPageId', '=', runPageId)
      .orderBy('imageOrdinal', 'asc')
      .execute();
    return {
      expectedExtractionIds: images
        .filter((image) => image.status === 'succeeded' && image.extractionId)
        .map((image) => image.extractionId as string),
      images: images.map((image) => ({
        attachmentId: image.attachmentId,
        fileName: image.fileName,
        mimeType: image.mimeType,
        fileSize: image.fileSize === null ? null : Number(image.fileSize),
        attachmentVersion: image.expectedAttachmentVersion.toISOString(),
        ...(image.altText ? { altText: image.altText } : {}),
      })),
    };
  }

  /**
   * Non-transactional heartbeat/liveness check for the page merge fence: every
   * identity dimension must still match a running page under the current
   * generation. Used by the worker heartbeat loop.
   */
  async isPageMergeFenceActive(
    fence: PageMergeExecutionFence,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom('knowledgeSpaceCompileRunPages as page')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'page.runId')
      .innerJoin('spaces as space', 'space.id', 'run.spaceId')
      .select('page.id')
      .where('page.id', '=', fence.runPageId)
      .where('page.runId', '=', fence.runId)
      .where('page.sourcePageId', '=', fence.sourcePageId)
      .where('page.mergeJobId', '=', fence.mergeJobId)
      .where('page.mergeExecutionToken', '=', fence.mergeExecutionToken)
      .where('page.mergeStatus', '=', 'running')
      .where('page.expectedSourceVersion', '=', fence.sourceVersion)
      .where('page.expectedSourceContentHash', '=', fence.sourceContentHash)
      .where('run.knowledgeGeneration', '=', fence.knowledgeGeneration)
      .where('run.status', 'in', PAGE_MERGE_RUN_STATUSES)
      .where('run.phase', 'in', PAGE_MERGE_RUN_PHASES)
      .where('space.knowledgeGeneration', '=', fence.knowledgeGeneration)
      .where('space.deletedAt', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  /**
   * Transactional publication guard. Locks Space -> Run -> RunPage in canonical
   * order and re-validates the full fence inside the caller's publication
   * transaction so a stale worker (superseded token / generation / source
   * drift) can never publish.
   */
  async isPageMergeFenceActiveForPublication(
    fence: PageMergeExecutionFence,
    trx: KyselyTransaction,
  ): Promise<boolean> {
    const locked = await this.lockPageMergeRunPage(trx, {
      runId: fence.runId,
      runPageId: fence.runPageId,
      knowledgeGeneration: fence.knowledgeGeneration,
    });
    if (!locked) return false;
    const { page } = locked;
    return (
      page.mergeStatus === 'running' &&
      page.mergeJobId === fence.mergeJobId &&
      page.mergeExecutionToken === fence.mergeExecutionToken &&
      page.sourcePageId === fence.sourcePageId &&
      page.expectedSourceVersion === fence.sourceVersion &&
      page.expectedSourceContentHash === fence.sourceContentHash
    );
  }

  /**
   * Completes a successful page merge inside the caller's knowledge-publication
   * transaction: marks the page succeeded, records the effective hash, clears
   * the execution fence, then reconciles the run pipeline barrier. Returns false
   * if the fence no longer holds (stale worker), leaving the transaction to roll
   * back its publication.
   */
  async completePageMerge(
    fence: PageMergeExecutionFence,
    input: { effectiveKnowledgeHash: string },
    trx: KyselyTransaction,
  ): Promise<boolean> {
    const locked = await this.lockPageMergeRunPage(trx, {
      runId: fence.runId,
      runPageId: fence.runPageId,
      knowledgeGeneration: fence.knowledgeGeneration,
    });
    if (!locked) return false;
    const { run, page } = locked;
    if (
      page.mergeStatus !== 'running' ||
      page.mergeJobId !== fence.mergeJobId ||
      page.mergeExecutionToken !== fence.mergeExecutionToken ||
      page.sourcePageId !== fence.sourcePageId ||
      page.expectedSourceVersion !== fence.sourceVersion ||
      page.expectedSourceContentHash !== fence.sourceContentHash
    ) {
      return false;
    }
    await trx
      .updateTable('knowledgeSpaceCompileRunPages')
      .set({
        mergeStatus: 'succeeded',
        mergedEffectiveKnowledgeHash: input.effectiveKnowledgeHash,
        mergeExecutionToken: null,
        mergeProcessingExpiresAt: null,
        mergeWorkerId: null,
        mergeHeartbeatAt: null,
        updatedAt: new Date(),
      })
      .where('id', '=', page.id)
      .where('mergeStatus', '=', 'running')
      .execute();
    await reconcileRunPipelineInTransaction(trx, run.id);
    return true;
  }

  /**
   * Settles a non-successful page merge attempt.
   *
   * - retryable + attempts remaining: clears the execution token/expiry/
   *   heartbeat and returns the page to `queued`, keeping the deterministic job
   *   identity and dispatched flag so BullMQ's delayed retry re-claims the same
   *   job. The page keeps this run's single merge slot while it backs off.
   * - non-retryable OR budget exhausted: marks the page failed/skipped, records
   *   the failure class, clears the fence, and reconciles the run barrier so the
   *   freed slot lets the next ready page reserve.
   */
  async finishPageMerge(
    fence: PageMergeExecutionFence,
    input: {
      status: 'skipped' | 'failed';
      retryable?: boolean;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<{ terminal: boolean } | undefined> {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockPageMergeRunPage(trx, {
        runId: fence.runId,
        runPageId: fence.runPageId,
        knowledgeGeneration: fence.knowledgeGeneration,
      });
      if (!locked) return undefined;
      const { run, page } = locked;
      if (
        page.mergeStatus !== 'running' ||
        page.mergeJobId !== fence.mergeJobId ||
        page.mergeExecutionToken !== fence.mergeExecutionToken
      ) {
        return undefined;
      }
      const retryable = input.status === 'failed' && input.retryable !== false;
      const canRetry =
        retryable && page.mergeAttemptCount < MERGE_ATTEMPT_BUDGET;
      if (canRetry) {
        await trx
          .updateTable('knowledgeSpaceCompileRunPages')
          .set({
            mergeStatus: 'queued',
            mergeExecutionToken: null,
            mergeProcessingExpiresAt: null,
            mergeWorkerId: null,
            mergeHeartbeatAt: null,
            errorCode: diagnostic(input.errorCode, 80),
            errorMessage: diagnostic(input.errorMessage, 500),
            updatedAt: new Date(),
          })
          .where('id', '=', page.id)
          .where('mergeStatus', '=', 'running')
          .execute();
        return { terminal: false };
      }
      await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          mergeStatus: input.status,
          mergeFailureClass:
            input.status === 'failed'
              ? input.retryable === false
                ? 'permanent'
                : 'retryable_exhausted'
              : null,
          ...(['failed', 'skipped'].includes(input.status)
            ? { qualityStatus: 'partial_image' as const }
            : {}),
          mergeAttemptCount: MERGE_ATTEMPT_BUDGET,
          mergeExecutionToken: null,
          mergeProcessingExpiresAt: null,
          mergeWorkerId: null,
          mergeHeartbeatAt: null,
          errorCode: diagnostic(input.errorCode, 80),
          errorMessage: diagnostic(input.errorMessage, 500),
          updatedAt: new Date(),
        })
        .where('id', '=', page.id)
        .where('mergeStatus', '=', 'running')
        .execute();
      if (
        ['source_changed', 'image_snapshot_changed'].includes(
          input.errorCode ?? '',
        )
      ) {
        await trx
          .updateTable('knowledgeSpaceCompileRuns')
          .set({
            rerunRequested: true,
            ...this.followUpScopeUpdate(run, page.sourcePageId),
            updatedAt: new Date(),
          })
          .where('id', '=', run.id)
          .execute();
      }
      await reconcileRunPipelineInTransaction(trx, run.id);
      return { terminal: true };
    });
  }

  async heartbeatPageMerge(
    fence: PageMergeExecutionFence,
    input: { processingExpiresAt: Date },
  ): Promise<boolean> {
    const updated = await this.db
      .updateTable('knowledgeSpaceCompileRunPages')
      .set({
        mergeProcessingExpiresAt: input.processingExpiresAt,
        mergeHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where('id', '=', fence.runPageId)
      .where('runId', '=', fence.runId)
      .where('mergeStatus', '=', 'running')
      .where('mergeJobId', '=', fence.mergeJobId)
      .where('mergeExecutionToken', '=', fence.mergeExecutionToken)
      .returning('id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  async findPageMergeRecoveryCandidates(input: {
    processingExpiredBefore: Date;
    queuedDispatchedBefore: Date;
    limit?: number;
  }) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRunPages as page')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'page.runId')
      .select([
        'page.id as runPageId',
        'page.runId',
        'page.workspaceId',
        'page.spaceId',
        'page.sourcePageId',
        'page.mergeJobId',
        'page.mergeStatus',
        'page.mergeExecutionToken',
        'page.mergeDispatchedAt',
        'page.mergeProcessingExpiresAt',
        'page.mergeRedisRecoveryCount',
        'page.expectedSourceVersion',
        'page.expectedSourceContentHash',
        'run.knowledgeGeneration',
      ])
      .where('page.mergeJobId', 'is not', null)
      .where('run.phase', 'in', PAGE_MERGE_RUN_PHASES)
      .where('run.status', 'in', PAGE_MERGE_RUN_STATUSES)
      .where((expression) =>
        expression.or([
          expression.and([
            expression('page.mergeStatus', '=', 'running'),
            expression(
              'page.mergeProcessingExpiresAt',
              '<',
              input.processingExpiredBefore,
            ),
          ]),
          expression.and([
            expression('page.mergeStatus', '=', 'queued'),
            expression('page.mergeDispatchedAt', 'is not', null),
            expression(
              'page.mergeDispatchedAt',
              '<',
              input.queuedDispatchedBefore,
            ),
          ]),
        ]),
      )
      .orderBy('page.updatedAt', 'asc')
      .orderBy('page.id', 'asc')
      .limit(input.limit ?? 100)
      .execute();
  }

  /**
   * Reaper recovery: clears an expired running lease (or a stuck queued job)
   * back to a redispatchable `queued` state, bumping the redis recovery count.
   * If executions are already exhausted, settles failed instead; transport
   * recovery never replenishes the independent execution attempt budget.
   * Guarded by generation + job identity so a superseded page is never revived.
   */
  async requeueMissingPageMerge(
    input: PageMergeRecoveryObservation,
  ): Promise<boolean> {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockPageMergeRunPage(trx, input);
      if (!locked) return false;
      const { run, page } = locked;
      if (
        !this.matchesPageMergeRecoveryObservation(page, input) ||
        page.mergeRedisRecoveryCount >= MERGE_TRANSPORT_RECOVERY_BUDGET
      ) {
        return false;
      }
      if (page.mergeAttemptCount >= MERGE_ATTEMPT_BUDGET) {
        await this.failPageMergeInTransaction(trx, {
          runId: run.id,
          runPageId: page.id,
          errorCode: 'merge_job_attempts_exhausted',
          errorMessage: 'Page merge exhausted its execution attempt budget.',
        });
        return true;
      }
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          mergeStatus: 'queued',
          mergeExecutionToken: null,
          mergeProcessingExpiresAt: null,
          mergeWorkerId: null,
          mergeHeartbeatAt: null,
          mergeDispatchedAt: null,
          mergeRedisRecoveryCount: page.mergeRedisRecoveryCount + 1,
          updatedAt: new Date(),
        })
        .where('id', '=', page.id)
        .where('mergeJobId', '=', input.mergeJobId)
        .returning('id')
        .executeTakeFirst();
      return Boolean(updated);
    });
  }

  /**
   * Reaper terminalization by job identity (no execution token available).
   * Marks an unrecoverable page merge `failed`, clears the fence, and reconciles
   * the run barrier so the freed slot lets the next ready page proceed.
   */
  async terminalizePageMerge(
    input: PageMergeRecoveryObservation & {
      errorCode: string;
      errorMessage: string;
    },
  ): Promise<boolean> {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockPageMergeRunPage(trx, input);
      if (!locked) return false;
      const { run, page } = locked;
      if (!this.matchesPageMergeRecoveryObservation(page, input)) {
        return false;
      }
      await this.failPageMergeInTransaction(trx, {
        runId: run.id,
        runPageId: page.id,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      });
      return true;
    });
  }

  /** Caller holds Space -> Run -> RunPage and has validated its identity. */
  private async failPageMergeInTransaction(
    trx: KyselyTransaction,
    input: {
      runId: string;
      runPageId: string;
      errorCode: string;
      errorMessage: string;
    },
  ): Promise<void> {
    await trx
      .updateTable('knowledgeSpaceCompileRunPages')
      .set({
        mergeStatus: 'failed',
        mergeFailureClass: 'retryable_exhausted',
        qualityStatus: 'partial_image',
        mergeAttemptCount: MERGE_ATTEMPT_BUDGET,
        mergeExecutionToken: null,
        mergeProcessingExpiresAt: null,
        mergeWorkerId: null,
        mergeHeartbeatAt: null,
        errorCode: diagnostic(input.errorCode, 80),
        errorMessage: diagnostic(input.errorMessage, 500),
        updatedAt: new Date(),
      })
      .where('id', '=', input.runPageId)
      .where('runId', '=', input.runId)
      .execute();
    await reconcileRunPipelineInTransaction(trx, input.runId);
  }

  private matchesPageMergeRecoveryObservation(
    page: {
      mergeJobId: string | null;
      mergeStatus: string;
      mergeExecutionToken: string | null;
      mergeProcessingExpiresAt: Date | null;
      mergeDispatchedAt: Date | null;
      mergeRedisRecoveryCount: number;
    },
    input: PageMergeRecoveryObservation,
  ): boolean {
    const sameDate = (a: Date | null, b: Date | null) =>
      (a?.getTime() ?? null) === (b?.getTime() ?? null);
    if (
      page.mergeJobId !== input.mergeJobId ||
      page.mergeStatus !== input.mergeStatus ||
      page.mergeExecutionToken !== input.mergeExecutionToken ||
      page.mergeRedisRecoveryCount !== input.mergeRedisRecoveryCount ||
      !sameDate(
        page.mergeProcessingExpiresAt,
        input.mergeProcessingExpiresAt,
      ) ||
      !sameDate(page.mergeDispatchedAt, input.mergeDispatchedAt)
    )
      return false;
    return page.mergeStatus === 'running'
      ? Boolean(
          page.mergeProcessingExpiresAt &&
          page.mergeProcessingExpiresAt < input.observedAt,
        )
      : page.mergeStatus === 'queued' &&
          Boolean(
            page.mergeDispatchedAt &&
            page.mergeDispatchedAt < input.queuedDispatchedBefore,
          );
  }

  async claimSpaceLease(
    input: SpaceJobReservation & {
      workerId: string;
      executionToken?: string;
      executionLeaseExpiresAt: Date;
    },
  ): Promise<SpaceExecutionLease | undefined> {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockReservedRun(trx, input);
      if (!locked) return undefined;
      if (input.jobPhase === 'finalize') {
        const work = await readRunPipelineWork(trx, input.runId);
        if (
          !work ||
          work.textOutstanding ||
          work.imageOutstanding ||
          work.mergeOutstanding
        )
          return undefined;
      }
      const executionToken = input.executionToken ?? randomUUID();
      const now = new Date();
      const claimed = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          status: locked.phase === 'finalizing' ? 'aggregating' : 'compiling',
          executionToken,
          executionLeaseExpiresAt: input.executionLeaseExpiresAt,
          workerId: input.workerId,
          heartbeatAt: now,
          startedAt: locked.startedAt ?? now,
          spaceJobDispatchedAt: locked.spaceJobDispatchedAt ?? now,
          spaceJobRecoveryCount: 0,
          updatedAt: now,
        })
        .$call((query) => this.whereReservation(query, input))
        .where('phase', '=', locked.phase)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .returning('id')
        .executeTakeFirst();
      if (!claimed) return undefined;
      return { ...this.reservationIdentity(input), executionToken };
    });
  }

  async claimRecoveryLease(
    input: SpaceJobReservation & {
      workerId: string;
      executionToken?: string;
      leaseExpiredBefore: Date;
      executionLeaseExpiresAt: Date;
      recoveryKind: 'expired' | 'final_failed' | 'queued_reservation';
    },
  ): Promise<SpaceExecutionLease | undefined> {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockReservedRun(trx, input);
      if (!locked) {
        return undefined;
      }
      const isQueuedReservation =
        input.recoveryKind === 'queued_reservation' &&
        locked.status === 'queued';
      const requiresExpiredLease =
        input.recoveryKind === 'expired' ||
        (input.recoveryKind === 'queued_reservation' && !isQueuedReservation);
      if (
        requiresExpiredLease &&
        (!locked.executionLeaseExpiresAt ||
          locked.executionLeaseExpiresAt >= input.leaseExpiredBefore)
      ) {
        return undefined;
      }
      const executionToken = input.executionToken ?? randomUUID();
      const now = new Date();
      const claimed = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          executionToken,
          executionLeaseExpiresAt: input.executionLeaseExpiresAt,
          workerId: input.workerId,
          heartbeatAt: now,
          updatedAt: now,
        })
        .$call((query) => this.whereReservation(query, input))
        .where('phase', '=', locked.phase)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .$if(isQueuedReservation, (query) =>
          query.where('status', '=', 'queued'),
        )
        .$if(requiresExpiredLease, (query) =>
          query.where('executionLeaseExpiresAt', '<', input.leaseExpiredBefore),
        )
        .returning('id')
        .executeTakeFirst();
      if (!claimed) return undefined;
      return { ...this.reservationIdentity(input), executionToken };
    });
  }

  async heartbeatSpaceLease(
    lease: SpaceExecutionLease,
    input: { executionLeaseExpiresAt: Date },
  ): Promise<boolean> {
    const updated = await this.db
      .updateTable('knowledgeSpaceCompileRuns')
      .set({
        heartbeatAt: new Date(),
        executionLeaseExpiresAt: input.executionLeaseExpiresAt,
        updatedAt: new Date(),
      })
      .$call((query) => this.whereLease(query, lease))
      .where('phase', 'in', this.phasesFor(lease.jobPhase))
      .where('status', 'in', NONTERMINAL_RUN_STATUSES)
      .returning('id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  async initializeRun(
    lease: SpaceExecutionLease,
    input: {
      targetSourcePageIds: string[] | null;
    },
  ) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.phase !== 'text') return undefined;
      if (run.initializedAt) return { initialized: false, run };

      const now = new Date();
      const targetFilter = input.targetSourcePageIds?.length
        ? sql`AND page.id IN (${sql.join(input.targetSourcePageIds)})`
        : sql``;
      // Keep the projection metadata-only. In particular, this query must not
      // touch text_content, content, attachments, backlinks, or Catalog data.
      await sql`
        INSERT INTO knowledge_space_compile_run_pages (
          run_id,
          workspace_id,
          space_id,
          source_page_id,
          binding_status,
          discovered_source_version,
          expected_source_version,
          expected_source_content_hash,
          expected_image_count,
          index_mode,
          bound_at,
          status,
          image_status,
          merge_status,
          queued_at,
          updated_at
        )
        SELECT
          ${run.id},
          page.workspace_id,
          page.space_id,
          page.id,
          'unbound',
          page.updated_at,
          NULL,
          NULL,
          NULL,
          COALESCE(settings.index_mode, 'compiled'),
          NULL,
          'pending',
          'not_required',
          'not_required',
          ${now},
          ${now}
        FROM pages AS page
        LEFT JOIN knowledge_page_index_settings AS settings
          ON settings.workspace_id = page.workspace_id
         AND settings.source_page_id = page.id
        WHERE page.workspace_id = ${run.workspaceId}
          AND page.space_id = ${run.spaceId}
          AND page.deleted_at IS NULL
          ${targetFilter}
        ON CONFLICT (run_id, source_page_id) DO NOTHING
      `.execute(trx);

      const count = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select((expression) => expression.fn.countAll<number>().as('count'))
        .where('runId', '=', run.id)
        .executeTakeFirstOrThrow();
      const expectedPageCount = Number(count.count);
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          initializedAt: now,
          expectedPageCount,
          succeededPageCount: 0,
          failedPageCount: 0,
          skippedPageCount: 0,
          updatedAt: now,
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', 'text')
        .where('initializedAt', 'is', null)
        .returningAll()
        .executeTakeFirst();
      return updated ? { initialized: true, run: updated } : undefined;
    });
  }

  /** Atomically publishes the exact snapshot and image plan for one RunPage. */
  async bindTextPage(
    lease: SpaceExecutionLease,
    input: RunPageBindingPlan & { images: RunImageInitializationPlan[] },
  ) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.phase !== 'text') return undefined;
      const page = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .selectAll()
        .where('runId', '=', run.id)
        .where('sourcePageId', '=', input.sourcePageId)
        .where('bindingStatus', 'in', ['unbound', 'binding'])
        .where('status', 'in', ['pending', 'queued', 'running'])
        .forUpdate()
        .executeTakeFirst();
      if (!page) return undefined;

      const now = new Date();
      if (input.images.length > 0) {
        await trx
          .insertInto('knowledgeSpaceCompileRunImages')
          .values(
            input.images.map((image) => ({
              runId: run.id,
              runPageId: page.id,
              workspaceId: run.workspaceId,
              spaceId: run.spaceId,
              sourcePageId: input.sourcePageId,
              attachmentId: image.attachmentId,
              imageOrdinal: image.imageOrdinal,
              fileName: image.fileName,
              mimeType: image.mimeType,
              fileSize: image.fileSize ?? null,
              altText: image.altText ?? null,
              expectedAttachmentVersion: truncateToMilliseconds(
                image.expectedAttachmentVersion,
              ),
              status: image.status ?? 'pending',
              extractionId: image.extractionId ?? null,
              updatedAt: now,
            })),
          )
          .onConflict((conflict) =>
            conflict
              .columns(['runId', 'sourcePageId', 'attachmentId'])
              .doNothing(),
          )
          .execute();
      }

      const reused = input.reused ?? false;
      const bound = await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          bindingStatus: 'bound',
          boundAt: now,
          expectedSourceVersion: input.expectedSourceVersion,
          expectedSourceContentHash: input.expectedSourceContentHash,
          expectedImageCount: input.expectedImageCount,
          succeededImageCount: input.succeededImageCount ?? 0,
          failedImageCount: input.failedImageCount ?? 0,
          skippedImageCount: input.skippedImageCount ?? 0,
          status: reused ? 'succeeded' : input.status,
          imageStatus: input.imageStatus,
          mergeStatus: input.mergeStatus,
          targetEffectiveKnowledgeHash:
            input.targetEffectiveKnowledgeHash ?? null,
          errorCode: diagnostic(reused ? 'unchanged' : input.errorCode, 80),
          errorMessage: diagnostic(
            reused
              ? 'Existing compiled knowledge is current.'
              : input.errorMessage,
            500,
          ),
          qualityStatus: input.qualityStatus ?? 'normal',
          reused,
          finishedAt: reused ? now : null,
          updatedAt: now,
        })
        .where('id', '=', page.id)
        .where('bindingStatus', 'in', ['unbound', 'binding'])
        .returningAll()
        .executeTakeFirst();
      if (!bound) return undefined;

      if (reused) {
        await trx
          .updateTable('knowledgeSpaceCompileRuns')
          .set({
            succeededPageCount: run.succeededPageCount + 1,
            updatedAt: now,
          })
          .$call((query) => this.whereLease(query, lease))
          .where('phase', '=', 'text')
          .where('succeededPageCount', '=', run.succeededPageCount)
          .executeTakeFirst();
      }
      return bound;
    });
  }

  /** Terminalizes a page that disappeared before its exact snapshot bound. */
  async terminalizeUnboundTextPage(
    lease: SpaceExecutionLease,
    input: {
      sourcePageId: string;
      errorCode: string;
      errorMessage: string;
    },
  ) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.phase !== 'text') return undefined;
      const now = new Date();
      const page = await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          status: 'skipped',
          errorCode: diagnostic(input.errorCode, 80),
          errorMessage: diagnostic(input.errorMessage, 500),
          finishedAt: now,
          updatedAt: now,
        })
        .where('runId', '=', run.id)
        .where('sourcePageId', '=', input.sourcePageId)
        .where('bindingStatus', 'in', ['unbound', 'binding'])
        .where('status', 'in', ['pending', 'queued', 'running'])
        .returning('id')
        .executeTakeFirst();
      if (!page) return undefined;
      await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          skippedPageCount: run.skippedPageCount + 1,
          updatedAt: now,
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', 'text')
        .where('skippedPageCount', '=', run.skippedPageCount)
        .execute();
      return { terminalized: true };
    });
  }

  async completeTextPage(
    lease: SpaceExecutionLease,
    input: {
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
      status: Extract<
        KnowledgeSpaceCompileRunPageStatus,
        'succeeded' | 'failed' | 'skipped'
      >;
      retryable?: boolean;
      errorCode?: string | null;
      errorMessage?: string | null;
      qualityStatus?: 'normal' | 'degraded' | 'partial_image';
    },
  ) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.phase !== 'text') return undefined;
      const page = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .selectAll()
        .where('runId', '=', lease.runId)
        .where('sourcePageId', '=', input.sourcePageId)
        .where('bindingStatus', '=', 'bound')
        .where('expectedSourceVersion', '=', input.sourceVersion)
        .where('expectedSourceContentHash', '=', input.sourceContentHash)
        .forUpdate()
        .executeTakeFirst();
      if (!page) return undefined;
      const transitioned = !isPageTerminal(page.status);
      if (transitioned) {
        const now = new Date();
        await trx
          .updateTable('knowledgeSpaceCompileRunPages')
          .set({
            status: input.status,
            ...(input.status === 'failed' && input.retryable === false
              ? { attemptCount: PAGE_ATTEMPT_BUDGET }
              : {}),
            errorCode: diagnostic(input.errorCode, 80),
            errorMessage: diagnostic(input.errorMessage, 500),
            ...(input.qualityStatus && page.qualityStatus !== 'partial_image'
              ? { qualityStatus: input.qualityStatus }
              : {}),
            finishedAt: now,
            updatedAt: now,
          })
          .where('id', '=', page.id)
          .where('status', 'in', ['pending', 'queued', 'running'])
          .execute();
      }
      const counts = {
        succeeded:
          run.succeededPageCount +
          (transitioned && input.status === 'succeeded' ? 1 : 0),
        failed:
          run.failedPageCount +
          (transitioned && input.status === 'failed' ? 1 : 0),
        skipped:
          run.skippedPageCount +
          (transitioned && input.status === 'skipped' ? 1 : 0),
      };
      const barrierComplete =
        counts.succeeded + counts.failed + counts.skipped >=
        run.expectedPageCount;
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          succeededPageCount: counts.succeeded,
          failedPageCount: counts.failed,
          skippedPageCount: counts.skipped,
          ...(input.errorCode === 'source_changed'
            ? {
                rerunRequested: true,
                ...this.followUpScopeUpdate(run, input.sourcePageId),
              }
            : {}),
          updatedAt: new Date(),
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', 'text')
        .returning('id')
        .executeTakeFirst();
      if (!updated) return undefined;
      return {
        barrierComplete,
        succeededPageCount: counts.succeeded,
        failedPageCount: counts.failed,
        skippedPageCount: counts.skipped,
      };
    });
  }

  async advanceTextBarrier(lease: SpaceExecutionLease) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run) return undefined;
      const counts = {
        succeeded: run.succeededPageCount,
        failed: run.failedPageCount,
        skipped: run.skippedPageCount,
      };
      if (run.phase !== 'text') return undefined;
      const barrierComplete =
        counts.succeeded + counts.failed + counts.skipped >=
        run.expectedPageCount;
      if (!barrierComplete) {
        return {
          barrierComplete: false,
          imagesRequired: false,
          mergeRequired: false,
          readyToFinalize: false,
          reclaimed: false,
          ...counts,
        };
      }
      const now = new Date();

      const reclaimed = await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          status: 'pending',
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
          updatedAt: now,
        })
        .where('runId', '=', lease.runId)
        .where('status', '=', 'failed')
        .where('attemptCount', '<', PAGE_ATTEMPT_BUDGET)
        .returning('id')
        .execute();
      if (reclaimed.length > 0) {
        const recounted = await this.recountPagesFromRows(trx, lease.runId);
        const settled = await trx
          .updateTable('knowledgeSpaceCompileRuns')
          .set({ ...recounted, updatedAt: now })
          .$call((query) => this.whereLease(query, lease))
          .where('phase', '=', 'text')
          .returning('id')
          .executeTakeFirst();
        if (!settled) {
          throw new Error(
            `Knowledge Run ${lease.runId} lost its lease inside text settlement.`,
          );
        }
        return {
          barrierComplete: false,
          imagesRequired: false,
          mergeRequired: false,
          readyToFinalize: false,
          reclaimed: true,
          succeeded: recounted.succeededPageCount,
          failed: recounted.failedPageCount,
          skipped: recounted.skippedPageCount,
        };
      }

      const reconciled = await reconcileRunPipelineInTransaction(
        trx,
        lease.runId,
        { textBarrierSettled: true },
      );
      return reconciled
        ? {
            barrierComplete: true,
            ...reconciled,
            reclaimed: false,
            ...counts,
          }
        : undefined;
    });
  }

  private async recountPagesFromRows(trx: KyselyTransaction, runId: string) {
    const rows = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select(['status'])
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('runId', '=', runId)
      .groupBy('status')
      .execute();
    const countFor = (status: KnowledgeSpaceCompileRunPageStatus) =>
      Number(rows.find((row) => row.status === status)?.count ?? 0);
    return {
      succeededPageCount: countFor('succeeded'),
      failedPageCount: countFor('failed'),
      skippedPageCount: countFor('skipped'),
    };
  }

  async yieldSpaceLease(
    lease: SpaceExecutionLease,
    input: { reason: 'page_limit' | 'time_limit' },
  ): Promise<boolean> {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.phase !== 'text') return false;
      const remaining = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select('id')
        .where('runId', '=', lease.runId)
        .where('status', 'in', ['pending', 'queued', 'running'])
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (!remaining) return false;
      const now = new Date();
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          status: 'queued',
          spaceJobId: null,
          spaceJobDispatchedAt: null,
          spaceJobQueuedAt: now,
          executionToken: null,
          executionLeaseExpiresAt: null,
          workerId: null,
          heartbeatAt: null,
          lastYieldAt: now,
          lastYieldReason: input.reason,
          updatedAt: now,
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', run.phase)
        .returning('id')
        .executeTakeFirst();
      return Boolean(updated);
    });
  }

  async requeueMissingSpaceJob(lease: SpaceExecutionLease): Promise<boolean> {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.spaceJobRecoveryCount >= 3) return false;
      const now = new Date();
      await trx
        .updateTable('knowledgeCompilationAttempts')
        .set({
          status: 'skipped',
          errorCode: 'run_superseded',
          errorMessage: 'Knowledge Space job was requeued after recovery.',
          finishedAt: now,
          updatedAt: now,
        })
        .where('workspaceId', '=', run.workspaceId)
        .where('spaceId', '=', run.spaceId)
        .where('status', '=', 'running')
        .where('compileTaskId', 'like', `${lease.spaceJobId}__%`)
        .execute();
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          status: 'queued',
          spaceJobId: null,
          spaceJobDispatchedAt: null,
          spaceJobQueuedAt: now,
          spaceJobRecoveryCount: run.spaceJobRecoveryCount + 1,
          executionToken: null,
          executionLeaseExpiresAt: null,
          workerId: null,
          heartbeatAt: null,
          updatedAt: now,
        })
        .$call((query) => this.whereLease(query, lease))
        .where('spaceJobRecoveryCount', '=', run.spaceJobRecoveryCount)
        .returning('id')
        .executeTakeFirst();
      return Boolean(updated);
    });
  }

  async finishRun(
    lease: SpaceExecutionLease,
    outcome: Extract<
      KnowledgeSpaceCompileRunStatus,
      'succeeded' | 'partial' | 'failed'
    >,
    input: {
      errorCode?: string | null;
      errorMessage?: string | null;
      importedArtifactCount?: number;
      quarantinedArtifactCount?: number;
    } = {},
  ) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run) return undefined;
      if (outcome !== 'failed') {
        const work = await readRunPipelineWork(trx, lease.runId);
        if (
          run.phase !== 'finalizing' ||
          !work ||
          work.textOutstanding ||
          work.imageOutstanding ||
          work.mergeOutstanding
        )
          return undefined;
        const partial = await trx
          .selectFrom('knowledgeSpaceCompileRunPages')
          .select('id')
          .where('runId', '=', lease.runId)
          .where((eb) =>
            eb.or([
              eb('status', '=', 'failed'),
              eb('imageStatus', 'in', ['partial', 'failed']),
              eb('mergeStatus', 'in', ['skipped', 'failed']),
              eb('qualityStatus', '=', 'partial_image'),
            ]),
          )
          .limit(1)
          .executeTakeFirst();
        if (partial) outcome = 'partial';
      }
      const now = new Date();
      const finished = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          status: outcome,
          phase: 'complete',
          finishedAt: now,
          errorCode: diagnostic(input.errorCode, 80),
          errorMessage: diagnostic(input.errorMessage, 500),
          ...(input.importedArtifactCount !== undefined
            ? { importedArtifactCount: input.importedArtifactCount }
            : {}),
          ...(input.quarantinedArtifactCount !== undefined
            ? { quarantinedArtifactCount: input.quarantinedArtifactCount }
            : {}),
          executionToken: null,
          executionLeaseExpiresAt: null,
          workerId: null,
          heartbeatAt: null,
          updatedAt: now,
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', run.phase)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .returningAll()
        .executeTakeFirst();
      if (!finished) return undefined;

      let followUp;
      if (
        run.rerunRequested &&
        run.knowledgeGeneration === run.currentKnowledgeGeneration &&
        // A follow-up is a bounded convergence pass. If that pass also
        // requests a rerun (for example because image knowledge is still not
        // available), stop the automatic chain and require an explicit retry.
        run.trigger !== 'follow_up'
      ) {
        followUp = await trx
          .insertInto('knowledgeSpaceCompileRuns')
          .values({
            workspaceId: run.workspaceId,
            spaceId: run.spaceId,
            trigger: 'follow_up',
            mode: 'incremental',
            knowledgeGeneration: run.knowledgeGeneration,
            phase: 'text',
            status: 'queued',
            expectedPageCount: 0,
            compilerVersion: run.compilerVersion,
            promptVersion: run.promptVersion,
            // Page updates and snapshot changes that arrive after initialization
            // accumulate in a scope separate from the current Run's frozen plan.
            targetSourcePageIds: run.followUpTargetSourcePageIds,
            queuedAt: now,
            spaceJobQueuedAt: now,
            updatedAt: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return { run: finished, followUp };
    });
  }

  // When a page changes mid-run, accumulate it in the follow-up scope without
  // mutating the current Run's frozen discovery scope. An explicitly requested
  // full-Space follow-up stays full; otherwise only pages that changed after
  // initialization are unioned into the bounded follow-up.
  private followUpScopeUpdate(
    run: { followUpTargetSourcePageIds: unknown; rerunRequested: boolean },
    changedSourcePageId: string,
  ): { followUpTargetSourcePageIds?: JsonValue | null } {
    const scope = reconcileFollowUpTargetScope({
      followUpTargetSourcePageIds: parseTargetSourcePageIds(
        run.followUpTargetSourcePageIds,
      ),
      requestTargetSourcePageIds: [changedSourcePageId],
      rerunAlreadyRequested: run.rerunRequested,
    });
    return scope.changed
      ? {
          followUpTargetSourcePageIds:
            scope.targetSourcePageIds as JsonValue | null,
        }
      : {};
  }

  private async lockReservedRun(
    trx: KyselyTransaction,
    reservation: SpaceJobReservation,
  ) {
    const scope = await trx
      .selectFrom('knowledgeSpaceCompileRuns')
      .select(['workspaceId', 'spaceId'])
      .where('id', '=', reservation.runId)
      .executeTakeFirst();
    if (!scope) return undefined;
    const space = await trx
      .selectFrom('spaces')
      .select('knowledgeGeneration')
      .where('id', '=', scope.spaceId)
      .where('workspaceId', '=', scope.workspaceId)
      .where('deletedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (
      !space ||
      space.knowledgeGeneration !== reservation.knowledgeGeneration
    ) {
      return undefined;
    }
    const run = await trx
      .selectFrom('knowledgeSpaceCompileRuns')
      .selectAll()
      .$call((query) => this.whereReservation(query, reservation))
      .where('workspaceId', '=', scope.workspaceId)
      .where('spaceId', '=', scope.spaceId)
      .where('status', 'in', NONTERMINAL_RUN_STATUSES)
      .forUpdate()
      .executeTakeFirst();
    if (
      !run ||
      !this.phasesFor(reservation.jobPhase).includes(
        run.phase as KnowledgeSpaceCompileRunPhase,
      )
    ) {
      return undefined;
    }
    return run;
  }

  private async lockLeasedRun(
    trx: KyselyTransaction,
    lease: SpaceExecutionLease,
  ) {
    const run = await this.lockReservedRun(trx, lease);
    if (!run || run.executionToken !== lease.executionToken) return undefined;
    const currentKnowledgeGeneration = await trx
      .selectFrom('spaces')
      .select('knowledgeGeneration')
      .where('id', '=', run.spaceId)
      .where('workspaceId', '=', run.workspaceId)
      .executeTakeFirstOrThrow();
    return {
      ...run,
      currentKnowledgeGeneration:
        currentKnowledgeGeneration.knowledgeGeneration,
    };
  }

  private whereReservation<Query>(query: Query, input: SpaceJobReservation) {
    return (query as any)
      .where('id', '=', input.runId)
      .where('knowledgeGeneration', '=', input.knowledgeGeneration)
      .where('spaceJobSequence', '=', input.spaceJobSequence)
      .where('spaceJobId', '=', input.spaceJobId) as Query;
  }

  private whereLease<Query>(query: Query, lease: SpaceExecutionLease) {
    return (this.whereReservation(query, lease) as any).where(
      'executionToken',
      '=',
      lease.executionToken,
    ) as Query;
  }

  private reservationIdentity(input: SpaceJobReservation): SpaceJobReservation {
    return {
      runId: input.runId,
      knowledgeGeneration: input.knowledgeGeneration,
      jobPhase: input.jobPhase,
      spaceJobSequence: input.spaceJobSequence,
      spaceJobId: input.spaceJobId,
    };
  }

  private phasesFor(jobPhase: SpaceJobPhase) {
    return jobPhase === 'text' ? TEXT_PHASES : FINALIZE_PHASES;
  }
}

function isPageTerminal(status: string): boolean {
  return ['succeeded', 'failed', 'skipped'].includes(status);
}

function diagnostic(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  return value ? value.replace(/[\r\n\t]+/g, ' ').slice(0, maxLength) : null;
}

function truncateToMilliseconds(value: Date | string): Date {
  return new Date(new Date(value).toISOString());
}
