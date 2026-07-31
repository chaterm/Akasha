import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@akasha/db/types/db';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
import type {
  KnowledgeSpaceCompileRunPageImageStatus,
  KnowledgeSpaceCompileRunPageMergeStatus,
  KnowledgeSpaceCompileRunPageStatus,
  KnowledgeSpaceCompileRunPhase,
  KnowledgeSpaceCompileRunStatus,
} from './knowledge-space-compilation.repo';

export type SpaceJobPhase = 'text' | 'image_merge';

export interface SpaceExecutionLease {
  runId: string;
  knowledgeGeneration: number;
  jobPhase: SpaceJobPhase;
  spaceJobSequence: number;
  spaceJobId: string;
  executionToken: string;
}

export interface SpaceSliceReservation extends Omit<
  SpaceExecutionLease,
  'executionToken'
> {}

export interface RunPageInitializationPlan {
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
  targetEffectiveKnowledgeHash?: string | null;
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

const NONTERMINAL_RUN_STATUSES: KnowledgeSpaceCompileRunStatus[] = [
  'queued',
  'compiling',
  'aggregate_pending',
  'aggregating',
];

const TEXT_PHASES: KnowledgeSpaceCompileRunPhase[] = [
  'text',
  'initial_aggregate',
];
const IMAGE_MERGE_PHASES: KnowledgeSpaceCompileRunPhase[] = [
  'image_merge',
  'final_aggregate',
];

export function runPhaseToJobPhase(
  phase: KnowledgeSpaceCompileRunPhase,
): SpaceJobPhase {
  if (TEXT_PHASES.includes(phase)) return 'text';
  if (IMAGE_MERGE_PHASES.includes(phase)) return 'image_merge';
  throw new Error(`Run phase ${phase} does not use the Space queue.`);
}

export function buildSpaceSliceJobId(
  runId: string,
  phase: SpaceJobPhase,
  sequence: number,
): string {
  const name =
    phase === 'text' ? 'knowledge-space-text' : 'knowledge-space-image-merge';
  return `${name}__${runId}__${phase}__${sequence}`;
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
      .execute();
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
      .where('expectedSourceVersion', '=', input.sourceVersion)
      .where('expectedSourceContentHash', '=', input.sourceContentHash)
      .forUpdate()
      .executeTakeFirst();
    return Boolean(page);
  }

  async isLeaseActiveForSpacePublication(
    lease: SpaceExecutionLease,
    trx: KyselyTransaction,
  ): Promise<boolean> {
    return Boolean(await this.lockLeasedRun(trx, lease));
  }

  async hasImageWork(lease: SpaceExecutionLease): Promise<boolean> {
    const row = await this.db
      .selectFrom('knowledgeSpaceCompileRunPages as page')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'page.runId')
      .select('page.id')
      .where('run.id', '=', lease.runId)
      .where('run.knowledgeGeneration', '=', lease.knowledgeGeneration)
      .where('run.spaceJobSequence', '=', lease.spaceJobSequence)
      .where('run.spaceJobId', '=', lease.spaceJobId)
      .where('run.executionToken', '=', lease.executionToken)
      .where('page.imageStatus', 'in', ['pending', 'queued', 'processing'])
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  async claimSpaceSlice(
    input: SpaceSliceReservation & {
      workerId: string;
      executionToken?: string;
      executionLeaseExpiresAt: Date;
    },
  ): Promise<SpaceExecutionLease | undefined> {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockReservedRun(trx, input);
      if (!locked) return undefined;
      const executionToken = input.executionToken ?? randomUUID();
      const now = new Date();
      const claimed = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          status:
            locked.phase === 'initial_aggregate' ||
            locked.phase === 'final_aggregate'
              ? 'aggregating'
              : 'compiling',
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
    input: SpaceSliceReservation & {
      workerId: string;
      executionToken?: string;
      leaseExpiredBefore: Date;
      executionLeaseExpiresAt: Date;
      allowUnexpired?: boolean;
    },
  ): Promise<SpaceExecutionLease | undefined> {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockReservedRun(trx, input);
      if (
        !locked ||
        (!input.allowUnexpired &&
          (!locked.executionLeaseExpiresAt ||
            locked.executionLeaseExpiresAt >= input.leaseExpiredBefore))
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
        .$if(!input.allowUnexpired, (query) =>
          query.where('executionLeaseExpiresAt', '<', input.leaseExpiredBefore),
        )
        .returning('id')
        .executeTakeFirst();
      if (!claimed) return undefined;
      return { ...this.reservationIdentity(input), executionToken };
    });
  }

  async heartbeatSpaceSlice(
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
      catalogSnapshot: JsonValue;
      catalogHash: string;
      pages: RunPageInitializationPlan[];
      images: RunImageInitializationPlan[];
      removedSourcePageIds: string[];
    },
  ) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.phase !== 'text') return undefined;
      if (run.initializedAt) return { initialized: false, run };

      await this.retireRemovedSources(trx, run, input.removedSourcePageIds);
      const now = new Date();
      const insertedPages = input.pages.length
        ? await trx
            .insertInto('knowledgeSpaceCompileRunPages')
            .values(
              input.pages.map((page) => ({
                runId: run.id,
                workspaceId: run.workspaceId,
                spaceId: run.spaceId,
                sourcePageId: page.sourcePageId,
                expectedSourceVersion: page.expectedSourceVersion,
                expectedSourceContentHash: page.expectedSourceContentHash,
                expectedImageCount: page.expectedImageCount,
                succeededImageCount: page.succeededImageCount ?? 0,
                failedImageCount: page.failedImageCount ?? 0,
                skippedImageCount: page.skippedImageCount ?? 0,
                status: page.status,
                imageStatus: page.imageStatus,
                mergeStatus: page.mergeStatus,
                targetEffectiveKnowledgeHash:
                  page.targetEffectiveKnowledgeHash ?? null,
                errorCode: diagnostic(page.errorCode, 80),
                errorMessage: diagnostic(page.errorMessage, 500),
                queuedAt: page.status === 'pending' ? now : null,
                finishedAt: isPageTerminal(page.status) ? now : null,
                updatedAt: now,
              })),
            )
            .returning(['id', 'sourcePageId'])
            .execute()
        : [];
      const pageIds = new Map(
        insertedPages.map((page) => [page.sourcePageId, page.id]),
      );
      if (input.images.length > 0) {
        await trx
          .insertInto('knowledgeSpaceCompileRunImages')
          .values(
            input.images.map((image) => {
              const runPageId = pageIds.get(image.sourcePageId);
              if (!runPageId) {
                throw new Error(
                  `Image plan references missing RunPage ${image.sourcePageId}.`,
                );
              }
              return {
                runId: run.id,
                runPageId,
                workspaceId: run.workspaceId,
                spaceId: run.spaceId,
                sourcePageId: image.sourcePageId,
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
              };
            }),
          )
          .execute();
      }

      const succeededPageCount = input.pages.filter(
        (page) => page.status === 'succeeded',
      ).length;
      const failedPageCount = input.pages.filter(
        (page) => page.status === 'failed',
      ).length;
      const skippedPageCount = input.pages.filter(
        (page) => page.status === 'skipped',
      ).length;
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          initializedAt: now,
          catalogSnapshot: input.catalogSnapshot,
          catalogHash: input.catalogHash,
          expectedPageCount: input.pages.length,
          succeededPageCount,
          failedPageCount,
          skippedPageCount,
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
      errorCode?: string | null;
      errorMessage?: string | null;
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
        .where('expectedSourceVersion', '=', input.sourceVersion)
        .where('expectedSourceContentHash', '=', input.sourceContentHash)
        .forUpdate()
        .executeTakeFirst();
      if (!page) return undefined;
      if (!isPageTerminal(page.status)) {
        const now = new Date();
        await trx
          .updateTable('knowledgeSpaceCompileRunPages')
          .set({
            status: input.status,
            errorCode: diagnostic(input.errorCode, 80),
            errorMessage: diagnostic(input.errorMessage, 500),
            finishedAt: now,
            updatedAt: now,
          })
          .where('id', '=', page.id)
          .where('status', 'in', ['pending', 'queued', 'running'])
          .execute();
      }
      const counts = await this.countPageStatuses(trx, lease.runId);
      const barrierComplete =
        counts.succeeded + counts.failed + counts.skipped >=
        run.expectedPageCount;
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          succeededPageCount: counts.succeeded,
          failedPageCount: counts.failed,
          skippedPageCount: counts.skipped,
          ...(barrierComplete
            ? { phase: 'initial_aggregate', status: 'aggregating' }
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
      if (!run || run.phase !== 'text') return undefined;
      const counts = await this.countPageStatuses(trx, lease.runId);
      const barrierComplete =
        counts.succeeded + counts.failed + counts.skipped >=
        run.expectedPageCount;
      if (!barrierComplete) return { barrierComplete: false, ...counts };
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          phase: 'initial_aggregate',
          status: 'aggregating',
          succeededPageCount: counts.succeeded,
          failedPageCount: counts.failed,
          skippedPageCount: counts.skipped,
          updatedAt: new Date(),
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', 'text')
        .returning('id')
        .executeTakeFirst();
      return updated ? { barrierComplete: true, ...counts } : undefined;
    });
  }

  async completeMergePagePublication(
    lease: SpaceExecutionLease,
    input: {
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
      effectiveKnowledgeHash: string;
      status?: 'succeeded' | 'skipped';
    },
  ) {
    return this.finishMergePage(lease, {
      ...input,
      status: input.status ?? 'succeeded',
    });
  }

  async failMergePage(
    lease: SpaceExecutionLease,
    input: {
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ) {
    return this.finishMergePage(lease, { ...input, status: 'failed' });
  }

  async yieldSpaceSlice(
    lease: SpaceExecutionLease,
    input: { reason: 'page_limit' | 'time_limit' },
  ): Promise<boolean> {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || !['text', 'image_merge'].includes(run.phase)) return false;
      const remaining = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select('id')
        .where('runId', '=', lease.runId)
        .$if(run.phase === 'text', (query) =>
          query.where('status', 'in', ['pending', 'queued', 'running']),
        )
        .$if(run.phase === 'image_merge', (query) =>
          query.where('mergeStatus', 'in', ['pending', 'queued', 'running']),
        )
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

  async requeueMissingSpaceSlice(lease: SpaceExecutionLease): Promise<boolean> {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.spaceJobRecoveryCount >= 3) return false;
      const now = new Date();
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

  async completeInitialAggregate(
    lease: SpaceExecutionLease,
    input: {
      catalogSnapshot?: JsonValue;
      catalogHash?: string;
      importedArtifactCount?: number;
      quarantinedArtifactCount?: number;
      imagesRequired: boolean;
    },
  ) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.phase !== 'initial_aggregate') return undefined;
      const now = new Date();
      return trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          ...(input.catalogSnapshot !== undefined
            ? { catalogSnapshot: input.catalogSnapshot }
            : {}),
          ...(input.catalogHash !== undefined
            ? { catalogHash: input.catalogHash }
            : {}),
          ...(input.importedArtifactCount !== undefined
            ? { importedArtifactCount: input.importedArtifactCount }
            : {}),
          ...(input.quarantinedArtifactCount !== undefined
            ? { quarantinedArtifactCount: input.quarantinedArtifactCount }
            : {}),
          ...(input.imagesRequired
            ? {
                phase: 'images',
                status: 'compiling',
                spaceJobId: null,
                spaceJobDispatchedAt: null,
                executionToken: null,
                executionLeaseExpiresAt: null,
                workerId: null,
                heartbeatAt: null,
              }
            : {}),
          updatedAt: now,
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', 'initial_aggregate')
        .returningAll()
        .executeTakeFirst();
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
        run.knowledgeGeneration === run.currentKnowledgeGeneration
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
            catalogSnapshot: [] as JsonValue,
            catalogHash: 'pending-initialization',
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

  private async finishMergePage(
    lease: SpaceExecutionLease,
    input: {
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
      effectiveKnowledgeHash?: string;
      status: 'succeeded' | 'skipped' | 'failed';
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run || run.phase !== 'image_merge') return undefined;
      const page = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .selectAll()
        .where('runId', '=', lease.runId)
        .where('sourcePageId', '=', input.sourcePageId)
        .where('expectedSourceVersion', '=', input.sourceVersion)
        .where('expectedSourceContentHash', '=', input.sourceContentHash)
        .forUpdate()
        .executeTakeFirst();
      if (!page) return undefined;
      if (!['succeeded', 'skipped', 'failed'].includes(page.mergeStatus)) {
        await trx
          .updateTable('knowledgeSpaceCompileRunPages')
          .set({
            mergeStatus: input.status,
            mergedEffectiveKnowledgeHash: input.effectiveKnowledgeHash ?? null,
            errorCode: diagnostic(input.errorCode, 80),
            errorMessage: diagnostic(input.errorMessage, 500),
            updatedAt: new Date(),
          })
          .where('id', '=', page.id)
          .execute();
      }
      const remaining = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select('id')
        .where('runId', '=', lease.runId)
        .where('mergeStatus', 'in', [
          'pending',
          'queued',
          'running',
          'waiting_images',
        ])
        .limit(1)
        .executeTakeFirst();
      const barrierComplete = !remaining;
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          ...(barrierComplete
            ? { phase: 'final_aggregate', status: 'aggregating' }
            : {}),
          updatedAt: new Date(),
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', 'image_merge')
        .returning('id')
        .executeTakeFirst();
      return updated ? { barrierComplete } : undefined;
    });
  }

  private async lockReservedRun(
    trx: KyselyTransaction,
    reservation: SpaceSliceReservation,
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
      runPhaseToJobPhase(run.phase as KnowledgeSpaceCompileRunPhase) !==
        reservation.jobPhase
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

  private whereReservation<Query>(query: Query, input: SpaceSliceReservation) {
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

  private reservationIdentity(
    input: SpaceSliceReservation,
  ): SpaceSliceReservation {
    return {
      runId: input.runId,
      knowledgeGeneration: input.knowledgeGeneration,
      jobPhase: input.jobPhase,
      spaceJobSequence: input.spaceJobSequence,
      spaceJobId: input.spaceJobId,
    };
  }

  private phasesFor(jobPhase: SpaceJobPhase) {
    return jobPhase === 'text' ? TEXT_PHASES : IMAGE_MERGE_PHASES;
  }

  private async countPageStatuses(trx: KyselyTransaction, runId: string) {
    const pages = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select('status')
      .where('runId', '=', runId)
      .execute();
    return {
      succeeded: pages.filter((page) => page.status === 'succeeded').length,
      failed: pages.filter((page) => page.status === 'failed').length,
      skipped: pages.filter((page) => page.status === 'skipped').length,
    };
  }

  private async retireRemovedSources(
    trx: KyselyTransaction,
    run: { workspaceId: string; spaceId: string },
    sourcePageIds: string[],
  ): Promise<void> {
    if (sourcePageIds.length === 0) return;
    const contributions = await trx
      .selectFrom('knowledgeArtifactContributions')
      .select('artifactId')
      .distinct()
      .where('workspaceId', '=', run.workspaceId)
      .where('spaceId', '=', run.spaceId)
      .where('sourcePageId', 'in', sourcePageIds)
      .execute();
    await trx
      .deleteFrom('knowledgeArtifactContributions')
      .where('workspaceId', '=', run.workspaceId)
      .where('spaceId', '=', run.spaceId)
      .where('sourcePageId', 'in', sourcePageIds)
      .execute();
    const orphanedArtifactIds: string[] = [];
    for (const { artifactId } of contributions) {
      const owner = await trx
        .selectFrom('knowledgeArtifactContributions')
        .select('id')
        .where('artifactId', '=', artifactId)
        .limit(1)
        .executeTakeFirst();
      if (!owner) orphanedArtifactIds.push(artifactId);
    }
    if (orphanedArtifactIds.length > 0) {
      await trx
        .updateTable('knowledgePages')
        .set({ staleAt: new Date() })
        .where('workspaceId', '=', run.workspaceId)
        .where('spaceId', '=', run.spaceId)
        .where('id', 'in', orphanedArtifactIds)
        .execute();
    }
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
