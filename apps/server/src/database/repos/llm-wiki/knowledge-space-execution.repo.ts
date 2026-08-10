import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@akasha/db/types/db';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
import { sql } from 'kysely';
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

const NONTERMINAL_RUN_STATUSES: KnowledgeSpaceCompileRunStatus[] = [
  'queued',
  'compiling',
  'aggregate_pending',
  'aggregating',
];
const TEXT_PHASES: KnowledgeSpaceCompileRunPhase[] = [
  'text',
  'initial_aggregate',
  'finalizing',
];
const IMAGE_MERGE_PHASES: KnowledgeSpaceCompileRunPhase[] = [
  'image_merge',
  'final_aggregate',
  'finalizing',
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
      if (page.bindingStatus === 'unbound') {
        const updated = await trx
          .updateTable('knowledgeSpaceCompileRunPages')
          .set({ bindingStatus: 'binding', updatedAt: new Date() })
          .where('id', '=', page.id)
          .where('bindingStatus', '=', 'unbound')
          .returning('id')
          .executeTakeFirst();
        if (!updated) return undefined;
        return { ...page, bindingStatus: 'binding' as const };
      }
      return page;
    });
  }

  async findPendingMergePages(lease: SpaceExecutionLease) {
    const pages = await this.db
      .selectFrom('knowledgeSpaceCompileRunPages as page')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'page.runId')
      .select([
        'page.id',
        'page.sourcePageId',
        'page.expectedSourceVersion',
        'page.expectedSourceContentHash',
        'page.targetEffectiveKnowledgeHash',
        'page.createdAt',
      ])
      .where('run.id', '=', lease.runId)
      .where('run.knowledgeGeneration', '=', lease.knowledgeGeneration)
      .where('run.spaceJobSequence', '=', lease.spaceJobSequence)
      .where('run.spaceJobId', '=', lease.spaceJobId)
      .where('run.executionToken', '=', lease.executionToken)
      .where('run.phase', '=', 'image_merge')
      .where('run.status', 'in', NONTERMINAL_RUN_STATUSES)
      .where('page.mergeStatus', 'in', ['pending', 'queued', 'running'])
      .orderBy('page.createdAt', 'asc')
      .orderBy('page.sourcePageId', 'asc')
      .limit(1)
      .execute();
    if (pages.length === 0) return [];
    const images = await this.db
      .selectFrom('knowledgeSpaceCompileRunImages')
      .select([
        'runPageId',
        'attachmentId',
        'imageOrdinal',
        'fileName',
        'mimeType',
        'fileSize',
        'altText',
        'expectedAttachmentVersion',
      ])
      .where(
        'runPageId',
        'in',
        pages.map((page) => page.id),
      )
      .orderBy('runPageId', 'asc')
      .orderBy('imageOrdinal', 'asc')
      .execute();
    const imagesByPage = new Map<string, typeof images>();
    for (const image of images) {
      const pageImages = imagesByPage.get(image.runPageId) ?? [];
      pageImages.push(image);
      imagesByPage.set(image.runPageId, pageImages);
    }
    return pages.map((page) => ({
      ...page,
      images: (imagesByPage.get(page.id) ?? []).map((image) => ({
        attachmentId: image.attachmentId,
        fileName: image.fileName,
        mimeType: image.mimeType,
        fileSize: image.fileSize === null ? null : Number(image.fileSize),
        attachmentVersion: image.expectedAttachmentVersion.toISOString(),
        ...(image.altText ? { altText: image.altText } : {}),
      })),
    }));
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
      .where('bindingStatus', '=', 'bound')
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

  async isLeaseActiveForMergePublication(
    lease: SpaceExecutionLease,
    input: {
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
    },
    trx: KyselyTransaction,
  ): Promise<boolean> {
    const run = await this.lockLeasedRun(trx, lease);
    if (!run || run.phase !== 'image_merge') return false;
    const page = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select('id')
      .where('runId', '=', lease.runId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('bindingStatus', '=', 'bound')
      .where('expectedSourceVersion', '=', input.sourceVersion)
      .where('expectedSourceContentHash', '=', input.sourceContentHash)
      .where('mergeStatus', 'in', ['pending', 'queued', 'running'])
      .forUpdate()
      .executeTakeFirst();
    return Boolean(page);
  }

  async completeMergePagePublicationInTransaction(
    lease: SpaceExecutionLease,
    input: {
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
      effectiveKnowledgeHash: string;
    },
    trx: KyselyTransaction,
  ): Promise<boolean> {
    const run = await this.lockLeasedRun(trx, lease);
    if (!run || run.phase !== 'image_merge') return false;
    const page = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .selectAll()
      .where('runId', '=', lease.runId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('expectedSourceVersion', '=', input.sourceVersion)
      .where('expectedSourceContentHash', '=', input.sourceContentHash)
      .where('mergeStatus', 'in', ['pending', 'queued', 'running'])
      .forUpdate()
      .executeTakeFirst();
    if (!page) return false;
    await trx
      .updateTable('knowledgeSpaceCompileRunPages')
      .set({
        mergeStatus: 'succeeded',
        mergedEffectiveKnowledgeHash: input.effectiveKnowledgeHash,
        updatedAt: new Date(),
      })
      .where('id', '=', page.id)
      .where('mergeStatus', 'in', ['pending', 'queued', 'running'])
      .execute();
    const remaining = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select('id')
      .where('runId', '=', lease.runId)
      .where('mergeStatus', 'in', [
        'waiting_images',
        'pending',
        'queued',
        'running',
      ])
      .limit(1)
      .executeTakeFirst();
    if (!remaining) {
      await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          phase: 'finalizing',
          status: 'aggregating',
          updatedAt: new Date(),
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', 'image_merge')
        .execute();
    }
    return true;
  }

  async advanceMergeBarrier(lease: SpaceExecutionLease) {
    return executeTx(this.db, async (trx) => {
      const run = await this.lockLeasedRun(trx, lease);
      if (!run) return undefined;
      if (run.phase === 'finalizing' || run.phase === 'final_aggregate') {
        if (run.phase === 'final_aggregate') {
          await trx
            .updateTable('knowledgeSpaceCompileRuns')
            .set({
              phase: 'finalizing',
              status: 'aggregating',
              updatedAt: new Date(),
            })
            .$call((query) => this.whereLease(query, lease))
            .where('phase', '=', 'final_aggregate')
            .execute();
        }
        return { barrierComplete: true };
      }
      if (run.phase !== 'image_merge') return undefined;
      const remaining = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select('id')
        .where('runId', '=', lease.runId)
        .where('mergeStatus', 'in', [
          'waiting_images',
          'pending',
          'queued',
          'running',
        ])
        .limit(1)
        .executeTakeFirst();
      if (remaining) return { barrierComplete: false };
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          phase: 'finalizing',
          status: 'aggregating',
          updatedAt: new Date(),
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', 'image_merge')
        .returning('id')
        .executeTakeFirst();
      return updated ? { barrierComplete: true } : undefined;
    });
  }

  async hasPartialOutcome(lease: SpaceExecutionLease): Promise<boolean> {
    const row = await this.db
      .selectFrom('knowledgeSpaceCompileRunPages as page')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'page.runId')
      .select('page.id')
      .where('run.id', '=', lease.runId)
      .where('run.knowledgeGeneration', '=', lease.knowledgeGeneration)
      .where('run.spaceJobSequence', '=', lease.spaceJobSequence)
      .where('run.spaceJobId', '=', lease.spaceJobId)
      .where('run.executionToken', '=', lease.executionToken)
      .where((expression) =>
        expression.or([
          expression('page.status', '=', 'failed'),
          expression('page.imageStatus', 'in', ['partial', 'failed']),
          expression('page.mergeStatus', 'in', ['skipped', 'failed']),
          expression('page.qualityStatus', '=', 'partial_image'),
        ]),
      )
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
            locked.phase === 'final_aggregate' ||
            locked.phase === 'finalizing'
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
      targetSourcePageIds: string[] | null;
      aggregateRequired?: boolean;
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
          NULL,
          'pending',
          'not_required',
          'not_required',
          ${now},
          ${now}
        FROM pages AS page
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
          aggregateRequired: input.aggregateRequired ?? false,
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
            errorCode: diagnostic(input.errorCode, 80),
            errorMessage: diagnostic(input.errorMessage, 500),
            ...(input.qualityStatus
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
            ? { rerunRequested: true }
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
      if (run.phase === 'finalizing') {
        return {
          barrierComplete: true,
          imagesRequired: false,
          readyToFinalize: true,
          ...counts,
        };
      }
      if (!['text', 'initial_aggregate'].includes(run.phase)) return undefined;
      const barrierComplete =
        counts.succeeded + counts.failed + counts.skipped >=
        run.expectedPageCount;
      if (!barrierComplete) {
        return {
          barrierComplete: false,
          imagesRequired: false,
          readyToFinalize: false,
          ...counts,
        };
      }

      const imageWork = await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select('id')
        .where('runId', '=', lease.runId)
        .where((expression) =>
          expression.or([
            expression('imageStatus', 'in', [
              'pending',
              'queued',
              'processing',
            ]),
            expression('mergeStatus', 'in', ['waiting_images', 'pending']),
          ]),
        )
        .limit(1)
        .executeTakeFirst();
      const pendingImage = imageWork
        ? await trx
            .selectFrom('knowledgeSpaceCompileRunImages')
            .select('id')
            .where('runId', '=', lease.runId)
            .where('status', 'in', ['pending', 'queued', 'processing'])
            .limit(1)
            .executeTakeFirst()
        : undefined;
      const nextPhase = imageWork
        ? pendingImage
          ? 'images'
          : 'image_merge'
        : 'finalizing';
      const now = new Date();
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          phase: nextPhase,
          status:
            nextPhase === 'images'
              ? 'compiling'
              : nextPhase === 'image_merge'
                ? 'queued'
                : 'aggregating',
          succeededPageCount: counts.succeeded,
          failedPageCount: counts.failed,
          skippedPageCount: counts.skipped,
          ...(imageWork
            ? {
                spaceJobId: null,
                spaceJobDispatchedAt: null,
                ...(nextPhase === 'image_merge'
                  ? { spaceJobQueuedAt: now }
                  : {}),
                executionToken: null,
                executionLeaseExpiresAt: null,
                workerId: null,
                heartbeatAt: null,
              }
            : {}),
          updatedAt: now,
        })
        .$call((query) => this.whereLease(query, lease))
        .where('phase', '=', run.phase)
        .returning('id')
        .executeTakeFirst();
      return updated
        ? {
            barrierComplete: true,
            imagesRequired: Boolean(imageWork),
            readyToFinalize: !imageWork,
            ...counts,
          }
        : undefined;
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
      await trx
        .updateTable('knowledgeCompilationAttempts')
        .set({
          status: 'skipped',
          errorCode: 'run_superseded',
          errorMessage: 'Knowledge Space slice was requeued after recovery.',
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
      catalogHash?: string;
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
          ...(input.catalogHash !== undefined
            ? { catalogHash: input.catalogHash }
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
            aggregateRequired: false,
            // Page updates that arrive after initialization are coalesced into
            // the active Run's requested scope. Carry that bounded scope to
            // the follow-up instead of silently widening it to the whole Space.
            targetSourcePageIds: run.targetSourcePageIds,
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
        .where('bindingStatus', '=', 'bound')
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
            ...(input.status === 'succeeded'
              ? {}
              : { qualityStatus: 'partial_image' as const }),
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
            ? { phase: 'finalizing', status: 'aggregating' }
            : {}),
          ...(['source_changed', 'image_snapshot_changed'].includes(
            input.errorCode ?? '',
          )
            ? { rerunRequested: true }
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
      (run.phase !== 'finalizing' &&
        runPhaseToJobPhase(run.phase as KnowledgeSpaceCompileRunPhase) !==
          reservation.jobPhase)
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
