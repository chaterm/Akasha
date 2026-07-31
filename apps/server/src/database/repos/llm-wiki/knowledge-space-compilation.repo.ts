import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@akasha/db/types/db';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
import { sql } from 'kysely';
import {
  buildSpaceSliceJobId,
  runPhaseToJobPhase,
} from './knowledge-space-execution.repo';

export type KnowledgeSpaceCompileRunStatus =
  | 'queued'
  | 'compiling'
  | 'aggregate_pending'
  | 'aggregating'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'superseded';

export type KnowledgeSpaceCompileRunMode = 'incremental' | 'force_rebuild';

export type KnowledgeSpaceCompileRunPhase =
  | 'text'
  | 'initial_aggregate'
  | 'images'
  | 'image_merge'
  | 'final_aggregate'
  | 'complete';

export type SpaceRunRequestDisposition =
  | 'created'
  | 'coalesced'
  | 'rerun_requested';

export interface SpaceRunRequest {
  workspaceId: string;
  spaceId: string;
  trigger: string;
  confirmationSpaceName?: string;
  removedSourcePageIds?: string[];
  scanRemovedSources?: boolean;
}

export interface RequestRunsInput {
  requests: SpaceRunRequest[];
  compilerVersion: string;
  promptVersion: string;
}

type ActiveRunForRequest = {
  status: string;
  phase: string;
  initializedAt: Date | null;
};

export function decideSpaceRunRequest(
  activeRun: ActiveRunForRequest | undefined,
): SpaceRunRequestDisposition {
  if (!activeRun) return 'created';
  if (
    activeRun.status === 'queued' &&
    activeRun.phase === 'text' &&
    activeRun.initializedAt === null
  ) {
    return 'coalesced';
  }
  return 'rerun_requested';
}

export type KnowledgeSpaceCompileRunPageImageStatus =
  | 'not_required'
  | 'pending'
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'partial'
  | 'failed';

export type KnowledgeSpaceCompileRunPageMergeStatus =
  | 'not_required'
  | 'waiting_images'
  | 'pending'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'failed';

export type KnowledgeSpaceCompileRunPageStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped';

const NONTERMINAL_RUN_STATUSES: KnowledgeSpaceCompileRunStatus[] = [
  'queued',
  'compiling',
  'aggregate_pending',
  'aggregating',
];

@Injectable()
export class KnowledgeSpaceCompilationRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findSpaceSliceReservationCandidates(limit = 100) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .select(['id', 'workspaceId', 'spaceId', 'phase', 'spaceJobQueuedAt'])
      .where('status', '=', 'queued')
      .where('phase', 'in', [
        'text',
        'initial_aggregate',
        'image_merge',
        'final_aggregate',
      ])
      .where('spaceJobId', 'is', null)
      .orderBy(
        sql<number>`CASE WHEN phase IN ('image_merge', 'final_aggregate') THEN 1 ELSE 5 END`,
        'asc',
      )
      .orderBy('spaceJobQueuedAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
  }

  async findUndispatchedSpaceSlices(limit = 100) {
    const rows = await this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .select([
        'id',
        'workspaceId',
        'spaceId',
        'phase',
        'knowledgeGeneration',
        'spaceJobSequence',
        'spaceJobId',
        'spaceJobQueuedAt',
      ])
      .where('status', '=', 'queued')
      .where('phase', 'in', [
        'text',
        'initial_aggregate',
        'image_merge',
        'final_aggregate',
      ])
      .where('spaceJobId', 'is not', null)
      .where('spaceJobDispatchedAt', 'is', null)
      .orderBy(
        sql<number>`CASE WHEN phase IN ('image_merge', 'final_aggregate') THEN 1 ELSE 5 END`,
        'asc',
      )
      .orderBy('spaceJobQueuedAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    return rows.map((run) => ({
      runId: run.id,
      workspaceId: run.workspaceId,
      spaceId: run.spaceId,
      knowledgeGeneration: run.knowledgeGeneration,
      jobPhase: runPhaseToJobPhase(run.phase as KnowledgeSpaceCompileRunPhase),
      spaceJobSequence: run.spaceJobSequence,
      spaceJobId: run.spaceJobId!,
      spaceJobQueuedAt: run.spaceJobQueuedAt,
    }));
  }

  async markSpaceSliceDispatched(input: {
    runId: string;
    knowledgeGeneration: number;
    jobPhase: 'text' | 'image_merge';
    spaceJobSequence: number;
    spaceJobId: string;
  }): Promise<boolean> {
    const phases =
      input.jobPhase === 'text'
        ? (['text', 'initial_aggregate'] as const)
        : (['image_merge', 'final_aggregate'] as const);
    const updated = await this.db
      .updateTable('knowledgeSpaceCompileRuns')
      .set({ spaceJobDispatchedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', input.runId)
      .where('knowledgeGeneration', '=', input.knowledgeGeneration)
      .where('phase', 'in', phases)
      .where('status', '=', 'queued')
      .where('spaceJobSequence', '=', input.spaceJobSequence)
      .where('spaceJobId', '=', input.spaceJobId)
      .where('spaceJobDispatchedAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  async reserveNextSpaceSlice(input: { runId: string }) {
    return executeTx(this.db, async (trx) => {
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
      if (!space) return undefined;

      const run = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .selectAll()
        .where('id', '=', input.runId)
        .where('workspaceId', '=', scope.workspaceId)
        .where('spaceId', '=', scope.spaceId)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .forUpdate()
        .executeTakeFirst();
      if (
        !run ||
        run.spaceJobId !== null ||
        run.knowledgeGeneration !== space.knowledgeGeneration
      ) {
        return undefined;
      }

      let jobPhase;
      try {
        jobPhase = runPhaseToJobPhase(
          run.phase as KnowledgeSpaceCompileRunPhase,
        );
      } catch {
        return undefined;
      }
      const spaceJobSequence = run.spaceJobSequence + 1;
      const spaceJobId = buildSpaceSliceJobId(
        run.id,
        jobPhase,
        spaceJobSequence,
      );
      const reserved = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          spaceJobId,
          spaceJobSequence,
          spaceJobQueuedAt: run.spaceJobQueuedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', run.id)
        .where('spaceJobId', 'is', null)
        .where('spaceJobSequence', '=', run.spaceJobSequence)
        .returning(['id', 'knowledgeGeneration'])
        .executeTakeFirst();
      if (!reserved) return undefined;
      return {
        runId: reserved.id,
        knowledgeGeneration: reserved.knowledgeGeneration,
        jobPhase,
        spaceJobSequence,
        spaceJobId,
      };
    });
  }

  async requestRuns(input: RequestRunsInput) {
    const results = [];
    for (const request of input.requests) {
      results.push(
        await executeTx(this.db, async (trx) => {
          const now = new Date();
          const space = await trx
            .selectFrom('spaces')
            .select(['id', 'name', 'knowledgeGeneration'])
            .where('id', '=', request.spaceId)
            .where('workspaceId', '=', request.workspaceId)
            .where('deletedAt', 'is', null)
            .forUpdate()
            .executeTakeFirst();
          if (!space) {
            return {
              disposition: 'rejected' as const,
              reason: 'space_not_found' as const,
              run: null,
            };
          }
          if (
            request.confirmationSpaceName !== undefined &&
            request.confirmationSpaceName !== space.name
          ) {
            return {
              disposition: 'rejected' as const,
              reason: 'space_name_mismatch' as const,
              run: null,
            };
          }

          let activeRun = await trx
            .selectFrom('knowledgeSpaceCompileRuns')
            .selectAll()
            .where('workspaceId', '=', request.workspaceId)
            .where('spaceId', '=', request.spaceId)
            .where('status', 'in', NONTERMINAL_RUN_STATUSES)
            .forUpdate()
            .executeTakeFirst();

          const removedSourcePageIds = await this.resolveRemovedSourcePageIds(
            trx,
            request,
          );
          if (removedSourcePageIds.length > 0) {
            activeRun = await this.invalidateRemovedSourcesAndReplanInTx(
              trx,
              request,
              removedSourcePageIds,
              activeRun,
              now,
            );
          }

          const disposition = decideSpaceRunRequest(activeRun);
          if (disposition === 'coalesced') {
            return { disposition, run: activeRun! };
          }
          if (disposition === 'rerun_requested') {
            const run = await trx
              .updateTable('knowledgeSpaceCompileRuns')
              .set({ rerunRequested: true, updatedAt: now })
              .where('id', '=', activeRun!.id)
              .where('status', 'in', NONTERMINAL_RUN_STATUSES)
              .returningAll()
              .executeTakeFirst();
            return { disposition, run: run ?? activeRun! };
          }

          const run = await trx
            .insertInto('knowledgeSpaceCompileRuns')
            .values({
              workspaceId: request.workspaceId,
              spaceId: request.spaceId,
              trigger: request.trigger,
              mode: 'incremental',
              knowledgeGeneration: space.knowledgeGeneration,
              phase: 'text',
              status: 'queued',
              expectedPageCount: 0,
              compilerVersion: input.compilerVersion,
              promptVersion: input.promptVersion,
              catalogSnapshot: [] as JsonValue,
              catalogHash: 'pending-initialization',
              queuedAt: now,
              spaceJobQueuedAt: now,
              updatedAt: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return { disposition, run };
        }),
      );
    }
    return results;
  }

  async requestIncrementalCompileForPages(input: {
    workspaceId: string;
    sourcePageIds: string[];
    trigger: string;
    removed: boolean;
    compilerVersion: string;
    promptVersion: string;
  }) {
    if (input.sourcePageIds.length === 0) return [];
    const scopes = input.removed
      ? await sql<{ sourcePageId: string; spaceId: string }>`
          SELECT DISTINCT scope.source_page_id AS "sourcePageId",
                          scope.space_id AS "spaceId"
          FROM (
            SELECT id AS source_page_id, space_id
            FROM pages
            WHERE workspace_id = ${input.workspaceId}
              AND id IN (${sql.join(input.sourcePageIds)})
            UNION
            SELECT source_page_id, source_space_id AS space_id
            FROM knowledge_sources
            WHERE workspace_id = ${input.workspaceId}
              AND source_page_id IN (${sql.join(input.sourcePageIds)})
            UNION
            SELECT source_page_id, space_id
            FROM knowledge_artifact_contributions
            WHERE workspace_id = ${input.workspaceId}
              AND source_page_id IN (${sql.join(input.sourcePageIds)})
          ) AS scope
        `.execute(this.db)
      : await sql<{ sourcePageId: string; spaceId: string }>`
          SELECT id AS "sourcePageId", space_id AS "spaceId"
          FROM pages
          WHERE workspace_id = ${input.workspaceId}
            AND id IN (${sql.join(input.sourcePageIds)})
            AND deleted_at IS NULL
        `.execute(this.db);
    const pagesBySpace = new Map<string, string[]>();
    for (const row of scopes.rows) {
      const pages = pagesBySpace.get(row.spaceId) ?? [];
      pages.push(row.sourcePageId);
      pagesBySpace.set(row.spaceId, pages);
    }
    return this.requestRuns({
      requests: [...pagesBySpace].map(([spaceId, sourcePageIds]) => ({
        workspaceId: input.workspaceId,
        spaceId,
        trigger: input.trigger,
        ...(input.removed
          ? { removedSourcePageIds: [...new Set(sourcePageIds)] }
          : {}),
      })),
      compilerVersion: input.compilerVersion,
      promptVersion: input.promptVersion,
    });
  }

  async requestRunsForSourcePages(
    input: Parameters<
      KnowledgeSpaceCompilationRepo['requestIncrementalCompileForPages']
    >[0],
  ) {
    return this.requestIncrementalCompileForPages(input);
  }

  private async resolveRemovedSourcePageIds(
    trx: KyselyTransaction,
    request: SpaceRunRequest,
  ): Promise<string[]> {
    const explicit = [...new Set(request.removedSourcePageIds ?? [])];
    if (!request.scanRemovedSources) return explicit;
    const discovered = await sql<{ sourcePageId: string }>`
      SELECT DISTINCT known.source_page_id AS "sourcePageId"
      FROM (
        SELECT source_page_id
        FROM knowledge_sources
        WHERE workspace_id = ${request.workspaceId}
          AND source_space_id = ${request.spaceId}
        UNION
        SELECT source_page_id
        FROM knowledge_artifact_contributions
        WHERE workspace_id = ${request.workspaceId}
          AND space_id = ${request.spaceId}
      ) AS known
      WHERE NOT EXISTS (
        SELECT 1
        FROM pages page
        WHERE page.workspace_id = ${request.workspaceId}
          AND page.space_id = ${request.spaceId}
          AND page.id = known.source_page_id
          AND page.deleted_at IS NULL
      )
    `.execute(trx);
    return [
      ...new Set([
        ...explicit,
        ...discovered.rows.map((row) => row.sourcePageId),
      ]),
    ];
  }

  private async invalidateRemovedSourcesAndReplanInTx(
    trx: KyselyTransaction,
    request: SpaceRunRequest,
    removedSourcePageIds: string[],
    activeRun:
      | Awaited<ReturnType<KnowledgeSpaceCompilationRepo['findActiveRun']>>
      | undefined,
    now: Date,
  ) {
    await trx
      .updateTable('knowledgeSources')
      .set({ staleAt: now })
      .where('workspaceId', '=', request.workspaceId)
      .where('sourceSpaceId', '=', request.spaceId)
      .where('sourcePageId', 'in', removedSourcePageIds)
      .execute();

    const affectedArtifacts = await trx
      .selectFrom('knowledgeArtifactContributions')
      .select('artifactId')
      .distinct()
      .where('workspaceId', '=', request.workspaceId)
      .where('spaceId', '=', request.spaceId)
      .where('sourcePageId', 'in', removedSourcePageIds)
      .execute();
    const overviews = await trx
      .selectFrom('knowledgePages')
      .select('id')
      .where('workspaceId', '=', request.workspaceId)
      .where('spaceId', '=', request.spaceId)
      .where('compileScope', '=', 'space')
      .where('pageType', '=', 'overview')
      .where('staleAt', 'is', null)
      .execute();
    const artifactIds = [
      ...new Set([
        ...affectedArtifacts.map((row) => row.artifactId),
        ...overviews.map((row) => row.id),
      ]),
    ];
    if (artifactIds.length > 0) {
      await trx
        .updateTable('knowledgePages')
        .set({ staleAt: now })
        .where('workspaceId', '=', request.workspaceId)
        .where('spaceId', '=', request.spaceId)
        .where('id', 'in', artifactIds)
        .execute();
      for (const [table, ownerColumn] of [
        ['knowledgeParentSections', 'knowledgePageId'],
        ['knowledgeClaims', 'knowledgePageId'],
        ['knowledgeChunks', 'knowledgePageId'],
        ['knowledgeLinks', 'fromKnowledgePageId'],
        ['knowledgeGraphEdges', 'fromKnowledgePageId'],
      ] as const) {
        await trx
          .updateTable(table)
          .set({ staleAt: now })
          .where('workspaceId', '=', request.workspaceId)
          .where(ownerColumn, 'in', artifactIds)
          .execute();
      }
    }

    if (!activeRun?.initializedAt) return activeRun;
    const runPages = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select('id')
      .where('runId', '=', activeRun.id)
      .forUpdate()
      .execute();
    if (runPages.length > 0) {
      await trx
        .selectFrom('knowledgeSpaceCompileRunImages')
        .select('id')
        .where('runId', '=', activeRun.id)
        .forUpdate()
        .execute();
      await trx
        .deleteFrom('knowledgeSpaceCompileRunImages')
        .where('runId', '=', activeRun.id)
        .execute();
      await trx
        .deleteFrom('knowledgeSpaceCompileRunPages')
        .where('runId', '=', activeRun.id)
        .execute();
    }
    return trx
      .updateTable('knowledgeSpaceCompileRuns')
      .set({
        status: 'queued',
        phase: 'text',
        initializedAt: null,
        expectedPageCount: 0,
        succeededPageCount: 0,
        failedPageCount: 0,
        skippedPageCount: 0,
        importedArtifactCount: 0,
        quarantinedArtifactCount: 0,
        catalogSnapshot: [] as JsonValue,
        catalogHash: 'pending-initialization',
        aggregateJobId: null,
        aggregateStartedAt: null,
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
        spaceJobId: null,
        spaceJobDispatchedAt: null,
        spaceJobQueuedAt: now,
        spaceJobRecoveryCount: 0,
        executionToken: null,
        executionLeaseExpiresAt: null,
        workerId: null,
        heartbeatAt: null,
        lastYieldAt: null,
        lastYieldReason: null,
        updatedAt: now,
      })
      .where('id', '=', activeRun.id)
      .where('status', 'in', NONTERMINAL_RUN_STATUSES)
      .returningAll()
      .executeTakeFirst();
  }

  async forceResetAndCreateRun(input: {
    workspaceId: string;
    spaceId: string;
    confirmationSpaceName: string;
    trigger: string;
    compilerVersion: string;
    promptVersion: string;
    catalogSnapshot: JsonValue;
    catalogHash: string;
    sources: Array<{
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
      expectedImageCount?: number;
      targetEffectiveKnowledgeHash?: string | null;
    }>;
    deferInitialization?: boolean;
  }) {
    return executeTx(this.db, async (trx) => {
      const now = new Date();
      const space = await trx
        .selectFrom('spaces')
        .select(['id', 'name', 'knowledgeGeneration'])
        .where('id', '=', input.spaceId)
        .where('workspaceId', '=', input.workspaceId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!space) {
        return { reset: false as const, reason: 'space_not_found' as const };
      }
      if (space.name !== input.confirmationSpaceName) {
        return {
          reset: false as const,
          reason: 'space_name_mismatch' as const,
        };
      }

      const oldRuns = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .select(['id', 'aggregateJobId', 'skippedPageCount'])
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .forUpdate()
        .execute();
      const oldRunIds = oldRuns.map((run) => run.id);
      const oldPages =
        oldRunIds.length === 0
          ? []
          : await trx
              .updateTable('knowledgeSpaceCompileRunPages')
              .set({
                status: 'skipped',
                errorCode: 'run_superseded',
                errorMessage: 'Knowledge compilation run was superseded.',
                finishedAt: now,
                updatedAt: now,
              })
              .where('runId', 'in', oldRunIds)
              .where('status', 'in', ['pending', 'queued', 'running'])
              .returning(['runId', 'jobId', 'imageJobId', 'mergeJobId'])
              .execute();
      const skippedByRun = new Map<string, number>();
      for (const page of oldPages) {
        skippedByRun.set(page.runId, (skippedByRun.get(page.runId) ?? 0) + 1);
      }
      for (const oldRun of oldRuns) {
        await trx
          .updateTable('knowledgeSpaceCompileRuns')
          .set({
            status: 'superseded',
            skippedPageCount:
              oldRun.skippedPageCount + (skippedByRun.get(oldRun.id) ?? 0),
            errorCode: 'run_superseded',
            errorMessage:
              'A force rebuild replaced this knowledge compilation run.',
            finishedAt: now,
            updatedAt: now,
          })
          .where('id', '=', oldRun.id)
          .where('status', 'in', NONTERMINAL_RUN_STATUSES)
          .execute();
      }

      const generation = space.knowledgeGeneration + 1;
      await trx
        .updateTable('spaces')
        .set({ knowledgeGeneration: generation, updatedAt: now })
        .where('id', '=', input.spaceId)
        .where('workspaceId', '=', input.workspaceId)
        .execute();

      // These statements deliberately share this transaction and both scope
      // columns. History tables (attempts/runs/audits/reviews) are retained.
      await sql`
        DELETE FROM knowledge_source_access_principals
        WHERE workspace_id = ${input.workspaceId}
          AND source_page_id IN (
            SELECT source_page_id FROM knowledge_source_access_policy
            WHERE workspace_id = ${input.workspaceId}
              AND source_space_id = ${input.spaceId}
            UNION
            SELECT id FROM pages
            WHERE workspace_id = ${input.workspaceId}
              AND space_id = ${input.spaceId}
          )
      `.execute(trx);
      await sql`
        DELETE FROM knowledge_source_access_requirements
        WHERE workspace_id = ${input.workspaceId}
          AND source_page_id IN (
            SELECT source_page_id FROM knowledge_source_access_policy
            WHERE workspace_id = ${input.workspaceId}
              AND source_space_id = ${input.spaceId}
            UNION
            SELECT id FROM pages
            WHERE workspace_id = ${input.workspaceId}
              AND space_id = ${input.spaceId}
          )
      `.execute(trx);
      await trx
        .deleteFrom('knowledgeSourceAccessPolicy')
        .where('workspaceId', '=', input.workspaceId)
        .where('sourceSpaceId', '=', input.spaceId)
        .execute();
      await trx
        .deleteFrom('knowledgeArtifactContributions')
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .execute();
      await trx
        .deleteFrom('knowledgePages')
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .execute();
      await trx
        .deleteFrom('knowledgeSources')
        .where('workspaceId', '=', input.workspaceId)
        .where('sourceSpaceId', '=', input.spaceId)
        .execute();
      await sql`
        DELETE FROM knowledge_source_analyses
        WHERE workspace_id = ${input.workspaceId}
          AND (
            space_id = ${input.spaceId}
            OR source_page_id IN (
              SELECT id FROM pages
              WHERE workspace_id = ${input.workspaceId}
                AND space_id = ${input.spaceId}
            )
          )
      `.execute(trx);
      await trx
        .deleteFrom('knowledgeQuarantinedArtifacts')
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .execute();
      await trx
        .deleteFrom('knowledgeImageExtractions')
        .where('workspaceId', '=', input.workspaceId)
        .where(
          'attachmentId',
          'in',
          trx
            .selectFrom('attachments')
            .select('id')
            .where('workspaceId', '=', input.workspaceId)
            .where('spaceId', '=', input.spaceId),
        )
        .execute();
      await trx
        .updateTable('knowledgeCompilationAttempts')
        .set({
          status: 'skipped',
          stage: 'queued',
          compileTaskId: `force-reset:${generation}`,
          effectiveKnowledgeHash: null,
          lastSuccessfulEffectiveHash: null,
          lastSuccessfulSourceVersion: null,
          lastSuccessfulSourceHash: null,
          errorCode: 'force_rebuild_reset',
          errorMessage: 'Compiled knowledge was cleared by a force rebuild.',
          updatedAt: now,
        })
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .execute();

      const run = await trx
        .insertInto('knowledgeSpaceCompileRuns')
        .values({
          workspaceId: input.workspaceId,
          spaceId: input.spaceId,
          trigger: input.trigger,
          mode: 'force_rebuild',
          knowledgeGeneration: generation,
          phase: 'text',
          status: input.deferInitialization
            ? 'queued'
            : input.sources.length === 0
              ? 'aggregate_pending'
              : 'queued',
          expectedPageCount: input.deferInitialization
            ? 0
            : input.sources.length,
          compilerVersion: input.compilerVersion,
          promptVersion: input.promptVersion,
          catalogSnapshot: input.deferInitialization
            ? ([] as JsonValue)
            : input.catalogSnapshot,
          catalogHash: input.deferInitialization
            ? 'pending-initialization'
            : input.catalogHash,
          initializedAt: input.deferInitialization ? null : now,
          queuedAt: now,
          spaceJobQueuedAt: now,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (!input.deferInitialization && input.sources.length > 0) {
        await trx
          .insertInto('knowledgeSpaceCompileRunPages')
          .values(
            input.sources.map((source) => {
              const expectedImageCount = source.expectedImageCount ?? 0;
              return {
                runId: run.id,
                workspaceId: input.workspaceId,
                spaceId: input.spaceId,
                sourcePageId: source.sourcePageId,
                expectedSourceVersion: source.sourceVersion,
                expectedSourceContentHash: source.sourceContentHash,
                expectedImageCount,
                imageStatus:
                  expectedImageCount > 0
                    ? ('pending' as const)
                    : ('not_required' as const),
                mergeStatus:
                  expectedImageCount > 0
                    ? ('waiting_images' as const)
                    : ('not_required' as const),
                targetEffectiveKnowledgeHash:
                  source.targetEffectiveKnowledgeHash ?? null,
                status: 'pending' as const,
                updatedAt: now,
              };
            }),
          )
          .execute();
      }
      const supersededJobIds = [
        ...oldRuns.map((oldRun) => oldRun.aggregateJobId),
        ...oldPages.flatMap((page) => [
          page.jobId,
          page.imageJobId,
          page.mergeJobId,
        ]),
      ].filter((jobId): jobId is string => Boolean(jobId));
      return {
        reset: true as const,
        generation,
        run,
        supersededRunIds: oldRunIds,
        supersededJobIds: [...new Set(supersededJobIds)],
      };
    });
  }

  async forceResetAndRequestRun(input: {
    workspaceId: string;
    spaceId: string;
    confirmationSpaceName: string;
    trigger: string;
    compilerVersion: string;
    promptVersion: string;
  }) {
    return this.forceResetAndCreateRun({
      ...input,
      catalogSnapshot: [] as JsonValue,
      catalogHash: 'pending-initialization',
      sources: [],
      deferInitialization: true,
    });
  }

  async findActiveRun(input: { workspaceId: string; spaceId: string }) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('status', 'in', NONTERMINAL_RUN_STATUSES)
      .orderBy('createdAt', 'desc')
      .executeTakeFirst();
  }

  async findLatestCompletedRunForAggregateReuse(input: {
    workspaceId: string;
    spaceId: string;
    currentRunId: string;
  }) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRuns as run')
      .innerJoin('spaces as space', (join) =>
        join
          .onRef('space.id', '=', 'run.spaceId')
          .onRef('space.workspaceId', '=', 'run.workspaceId'),
      )
      .select([
        'run.id',
        'run.status',
        'run.phase',
        'run.compilerVersion',
        'run.promptVersion',
        'run.catalogHash',
        'run.knowledgeGeneration',
        'space.knowledgeGeneration as currentKnowledgeGeneration',
      ])
      .where('run.workspaceId', '=', input.workspaceId)
      .where('run.spaceId', '=', input.spaceId)
      .where('run.status', 'in', ['succeeded', 'partial'])
      .where('run.phase', '=', 'complete')
      .where('run.id', '!=', input.currentRunId)
      .orderBy('run.createdAt', 'desc')
      .executeTakeFirst();
  }

  async reserveRunImagesFairly(
    input: {
      maxOutstandingPerRun?: number;
      runLimit?: number;
    } = {},
  ) {
    const maxOutstandingPerRun = input.maxOutstandingPerRun ?? 5;
    const runs = await this.db
      .selectFrom('knowledgeSpaceCompileRuns as run')
      .select(['run.id'])
      .where('run.phase', '=', 'images')
      .where('run.status', '=', 'compiling')
      .where((expression) =>
        expression.exists(
          expression
            .selectFrom('knowledgeSpaceCompileRunImages as image')
            .select('image.id')
            .whereRef('image.runId', '=', 'run.id')
            .where('image.status', '=', 'pending'),
        ),
      )
      .orderBy('run.updatedAt', 'asc')
      .orderBy('run.id', 'asc')
      .limit(input.runLimit ?? 100)
      .execute();
    const reservations = [];
    for (const run of runs) {
      reservations.push(
        ...(await this.reserveRunImagesForRun(run.id, maxOutstandingPerRun)),
      );
    }
    return reservations;
  }

  async findUndispatchedRunImages(limit = 500) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRunImages as image')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'image.runId')
      .select([
        'image.id as runImageId',
        'image.runId',
        'image.workspaceId',
        'image.spaceId',
        'image.jobId',
        'run.knowledgeGeneration',
      ])
      .where('image.status', '=', 'queued')
      .where('image.jobId', 'is not', null)
      .where('image.dispatchedAt', 'is', null)
      .where('run.phase', '=', 'images')
      .where('run.status', '=', 'compiling')
      .orderBy('run.updatedAt', 'asc')
      .orderBy('image.createdAt', 'asc')
      .orderBy('image.id', 'asc')
      .limit(limit)
      .execute();
  }

  async markRunImageDispatched(input: {
    runImageId: string;
    runId: string;
    knowledgeGeneration: number;
    jobId: string;
  }): Promise<boolean> {
    const updated = await this.db
      .updateTable('knowledgeSpaceCompileRunImages')
      .set({ dispatchedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', input.runImageId)
      .where('runId', '=', input.runId)
      .where('status', '=', 'queued')
      .where('jobId', '=', input.jobId)
      .where('dispatchedAt', 'is', null)
      .where(
        'runId',
        'in',
        this.db
          .selectFrom('knowledgeSpaceCompileRuns')
          .select('id')
          .where('id', '=', input.runId)
          .where('knowledgeGeneration', '=', input.knowledgeGeneration)
          .where('phase', '=', 'images')
          .where('status', '=', 'compiling'),
      )
      .returning('id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  async findRunImageRecoveryCandidates(input: {
    processingExpiredBefore: Date;
    queuedDispatchedBefore: Date;
    limit?: number;
  }) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRunImages as image')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'image.runId')
      .select([
        'image.id as runImageId',
        'image.runId',
        'image.jobId',
        'image.redisRecoveryCount',
        'run.knowledgeGeneration',
      ])
      .where('image.jobId', 'is not', null)
      .where('run.phase', '=', 'images')
      .where('run.status', '=', 'compiling')
      .where((expression) =>
        expression.or([
          expression.and([
            expression('image.status', '=', 'processing'),
            expression(
              'image.processingExpiresAt',
              '<',
              input.processingExpiredBefore,
            ),
          ]),
          expression.and([
            expression('image.status', '=', 'queued'),
            expression('image.dispatchedAt', 'is not', null),
            expression('image.dispatchedAt', '<', input.queuedDispatchedBefore),
          ]),
        ]),
      )
      .orderBy('image.updatedAt', 'asc')
      .orderBy('image.id', 'asc')
      .limit(input.limit ?? 500)
      .execute();
  }

  async requeueMissingRunImage(input: {
    runImageId: string;
    runId: string;
    knowledgeGeneration: number;
    jobId: string;
  }): Promise<boolean> {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockRunImageIdentity(trx, input);
      if (
        !locked ||
        !['queued', 'processing'].includes(locked.image.status) ||
        locked.image.redisRecoveryCount >= 3
      ) {
        return false;
      }
      const updated = await trx
        .updateTable('knowledgeSpaceCompileRunImages')
        .set({
          status: 'queued',
          dispatchedAt: null,
          processingExpiresAt: null,
          redisRecoveryCount: locked.image.redisRecoveryCount + 1,
          updatedAt: new Date(),
        })
        .where('id', '=', input.runImageId)
        .where('runId', '=', input.runId)
        .where('jobId', '=', input.jobId)
        .where('redisRecoveryCount', '=', locked.image.redisRecoveryCount)
        .where('status', 'in', ['queued', 'processing'])
        .returning('id')
        .executeTakeFirst();
      return Boolean(updated);
    });
  }

  async claimRunImage(input: {
    runImageId: string;
    runId: string;
    knowledgeGeneration: number;
    jobId: string;
    processingExpiresAt: Date;
  }) {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockRunImageIdentity(trx, input);
      if (!locked || !['queued', 'processing'].includes(locked.image.status)) {
        return undefined;
      }
      return trx
        .updateTable('knowledgeSpaceCompileRunImages')
        .set({
          status: 'processing',
          processingExpiresAt: input.processingExpiresAt,
          attemptCount: locked.image.attemptCount + 1,
          redisRecoveryCount: 0,
          updatedAt: new Date(),
        })
        .where('id', '=', input.runImageId)
        .where('runId', '=', input.runId)
        .where('jobId', '=', input.jobId)
        .where('status', 'in', ['queued', 'processing'])
        .returningAll()
        .executeTakeFirst();
    });
  }

  async completeRunImage(input: {
    runImageId: string;
    runId: string;
    knowledgeGeneration: number;
    jobId: string;
    status: 'succeeded' | 'failed' | 'skipped';
    extractionId?: string | null;
    failureClass?: 'retryable_exhausted' | 'permanent' | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockRunImageIdentity(trx, input);
      if (!locked || !['queued', 'processing'].includes(locked.image.status)) {
        return undefined;
      }
      if (input.status === 'failed' && !input.failureClass) {
        throw new Error('A failed RunImage requires failureClass.');
      }
      const now = new Date();
      const image = await trx
        .updateTable('knowledgeSpaceCompileRunImages')
        .set({
          status: input.status,
          extractionId: input.extractionId ?? null,
          failureClass: input.status === 'failed' ? input.failureClass! : null,
          errorCode: diagnosticValue(input.errorCode, 80),
          errorMessage: diagnosticValue(input.errorMessage, 500),
          processingExpiresAt: null,
          updatedAt: now,
        })
        .where('id', '=', input.runImageId)
        .where('runId', '=', input.runId)
        .where('jobId', '=', input.jobId)
        .where('status', 'in', ['queued', 'processing'])
        .returningAll()
        .executeTakeFirst();
      if (!image) return undefined;

      const children = await trx
        .selectFrom('knowledgeSpaceCompileRunImages')
        .select(['status', 'failureClass'])
        .where('runPageId', '=', locked.page.id)
        .execute();
      const succeeded = children.filter(
        (child) => child.status === 'succeeded',
      ).length;
      const failed = children.filter(
        (child) => child.status === 'failed',
      ).length;
      const childSkipped = children.filter(
        (child) => child.status === 'skipped',
      ).length;
      const nonterminal = children.length - succeeded - failed - childSkipped;
      const overflowSkipped = Math.max(
        0,
        locked.page.expectedImageCount - children.length,
      );
      const skipped = overflowSkipped + childSkipped;
      const retryableExhausted = children.some(
        (child) =>
          child.status === 'failed' &&
          child.failureClass === 'retryable_exhausted',
      );
      const imageStatus =
        nonterminal > 0
          ? 'processing'
          : retryableExhausted
            ? 'failed'
            : failed > 0 || skipped > 0
              ? 'partial'
              : 'succeeded';
      await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          succeededImageCount: succeeded,
          failedImageCount: failed,
          skippedImageCount: skipped,
          imageStatus,
          ...(nonterminal === 0
            ? { mergeStatus: succeeded > 0 ? 'pending' : 'skipped' }
            : {}),
          updatedAt: now,
        })
        .where('id', '=', locked.page.id)
        .where('imageStatus', 'in', ['pending', 'queued', 'processing'])
        .execute();

      let barrierAdvanced = false;
      if (nonterminal === 0) {
        const remaining = await trx
          .selectFrom('knowledgeSpaceCompileRunImages')
          .select('id')
          .where('runId', '=', input.runId)
          .where('status', 'in', ['pending', 'queued', 'processing'])
          .limit(1)
          .executeTakeFirst();
        if (!remaining) {
          const advanced = await trx
            .updateTable('knowledgeSpaceCompileRuns')
            .set({
              phase: 'image_merge',
              status: 'queued',
              spaceJobId: null,
              spaceJobDispatchedAt: null,
              spaceJobQueuedAt: now,
              executionToken: null,
              executionLeaseExpiresAt: null,
              workerId: null,
              heartbeatAt: null,
              updatedAt: now,
            })
            .where('id', '=', input.runId)
            .where('knowledgeGeneration', '=', input.knowledgeGeneration)
            .where('phase', '=', 'images')
            .where('status', '=', 'compiling')
            .returning('id')
            .executeTakeFirst();
          barrierAdvanced = Boolean(advanced);
        }
      }
      return {
        image,
        imageStatus,
        succeeded,
        failed,
        skipped,
        barrierAdvanced,
      };
    });
  }

  async isRunActiveForImageWork(input: {
    runId: string;
    workspaceId: string;
    spaceId: string;
    sourcePageId: string;
    sourceVersion: string;
    sourceContentHash: string;
    knowledgeGeneration: number;
  }): Promise<boolean> {
    const row = await this.db
      .selectFrom('knowledgeSpaceCompileRunPages as rp')
      .innerJoin('knowledgeSpaceCompileRuns as r', 'r.id', 'rp.runId')
      .innerJoin('spaces as s', (join) =>
        join
          .onRef('s.id', '=', 'r.spaceId')
          .onRef('s.workspaceId', '=', 'r.workspaceId'),
      )
      .select('rp.id')
      .where('rp.runId', '=', input.runId)
      .where('rp.workspaceId', '=', input.workspaceId)
      .where('rp.spaceId', '=', input.spaceId)
      .where('rp.sourcePageId', '=', input.sourcePageId)
      .where('rp.expectedSourceVersion', '=', input.sourceVersion)
      .where('rp.expectedSourceContentHash', '=', input.sourceContentHash)
      .where('rp.imageStatus', 'in', ['queued', 'processing'])
      .where('r.status', '=', 'compiling')
      .where('r.phase', '=', 'images')
      .where('r.knowledgeGeneration', '=', input.knowledgeGeneration)
      .where('s.knowledgeGeneration', '=', input.knowledgeGeneration)
      .executeTakeFirst();
    return Boolean(row);
  }

  private async advanceFinalAggregateBarrier(
    trx: KyselyTransaction,
    runId: string,
    knowledgeGeneration: number,
  ): Promise<boolean> {
    const blocker = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select('id')
      .where('runId', '=', runId)
      .where((eb) =>
        eb.or([
          eb('imageStatus', 'not in', [
            'not_required',
            'succeeded',
            'partial',
            'failed',
          ]),
          eb('mergeStatus', 'not in', [
            'not_required',
            'succeeded',
            'skipped',
            'failed',
          ]),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    if (blocker) return false;
    const updated = await trx
      .updateTable('knowledgeSpaceCompileRuns')
      .set({
        status: 'aggregate_pending',
        phase: 'final_aggregate',
        aggregateJobId: null,
        updatedAt: new Date(),
      })
      .where('id', '=', runId)
      .where('knowledgeGeneration', '=', knowledgeGeneration)
      .where('phase', '=', 'images')
      .where('status', '=', 'compiling')
      .returning('id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  private async reserveRunImagesForRun(
    runId: string,
    maxOutstandingPerRun: number,
  ) {
    return executeTx(this.db, async (trx) => {
      const scope = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .select(['workspaceId', 'spaceId'])
        .where('id', '=', runId)
        .executeTakeFirst();
      if (!scope) return [];
      const space = await trx
        .selectFrom('spaces')
        .select('knowledgeGeneration')
        .where('id', '=', scope.spaceId)
        .where('workspaceId', '=', scope.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!space) return [];
      const run = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .selectAll()
        .where('id', '=', runId)
        .where('knowledgeGeneration', '=', space.knowledgeGeneration)
        .where('phase', '=', 'images')
        .where('status', '=', 'compiling')
        .forUpdate()
        .executeTakeFirst();
      if (!run) return [];
      const outstanding = await trx
        .selectFrom('knowledgeSpaceCompileRunImages')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('runId', '=', runId)
        .where('status', 'in', ['queued', 'processing'])
        .executeTakeFirstOrThrow();
      const slots = Math.max(
        0,
        maxOutstandingPerRun - Number(outstanding.count),
      );
      if (slots === 0) return [];
      const pending = await trx
        .selectFrom('knowledgeSpaceCompileRunImages')
        .select(['id', 'runPageId'])
        .where('runId', '=', runId)
        .where('status', '=', 'pending')
        .orderBy('createdAt', 'asc')
        .orderBy('imageOrdinal', 'asc')
        .limit(slots)
        .execute();
      if (pending.length === 0) return [];
      const pageIds = [...new Set(pending.map((image) => image.runPageId))];
      await trx
        .selectFrom('knowledgeSpaceCompileRunPages')
        .select('id')
        .where('id', 'in', pageIds)
        .orderBy('id', 'asc')
        .forUpdate()
        .execute();
      const images = await trx
        .selectFrom('knowledgeSpaceCompileRunImages')
        .selectAll()
        .where(
          'id',
          'in',
          pending.map((image) => image.id),
        )
        .where('status', '=', 'pending')
        .orderBy('id', 'asc')
        .forUpdate()
        .skipLocked()
        .execute();
      const reservations = [];
      for (const image of images) {
        const jobId = buildRunImageJobId(
          run.id,
          image.id,
          run.knowledgeGeneration,
        );
        const updated = await trx
          .updateTable('knowledgeSpaceCompileRunImages')
          .set({
            status: 'queued',
            jobId,
            dispatchedAt: null,
            updatedAt: new Date(),
          })
          .where('id', '=', image.id)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst();
        if (!updated) continue;
        reservations.push({
          runImageId: image.id,
          runId: run.id,
          workspaceId: run.workspaceId,
          spaceId: run.spaceId,
          knowledgeGeneration: run.knowledgeGeneration,
          jobId,
        });
      }
      return reservations;
    });
  }

  private async lockRunImageIdentity(
    trx: KyselyTransaction,
    input: {
      runImageId: string;
      runId: string;
      knowledgeGeneration: number;
      jobId: string;
    },
  ) {
    const identity = await trx
      .selectFrom('knowledgeSpaceCompileRunImages')
      .select(['runPageId', 'workspaceId', 'spaceId'])
      .where('id', '=', input.runImageId)
      .where('runId', '=', input.runId)
      .executeTakeFirst();
    if (!identity) return undefined;
    const space = await trx
      .selectFrom('spaces')
      .select('id')
      .where('id', '=', identity.spaceId)
      .where('workspaceId', '=', identity.workspaceId)
      .where('knowledgeGeneration', '=', input.knowledgeGeneration)
      .forUpdate()
      .executeTakeFirst();
    if (!space) return undefined;
    const run = await trx
      .selectFrom('knowledgeSpaceCompileRuns')
      .selectAll()
      .where('id', '=', input.runId)
      .where('workspaceId', '=', identity.workspaceId)
      .where('spaceId', '=', identity.spaceId)
      .where('knowledgeGeneration', '=', input.knowledgeGeneration)
      .where('phase', '=', 'images')
      .where('status', '=', 'compiling')
      .forUpdate()
      .executeTakeFirst();
    if (!run) return undefined;
    const page = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .selectAll()
      .where('id', '=', identity.runPageId)
      .where('runId', '=', input.runId)
      .forUpdate()
      .executeTakeFirst();
    if (!page) return undefined;
    const image = await trx
      .selectFrom('knowledgeSpaceCompileRunImages')
      .selectAll()
      .where('id', '=', input.runImageId)
      .where('runId', '=', input.runId)
      .where('runPageId', '=', page.id)
      .where('jobId', '=', input.jobId)
      .forUpdate()
      .executeTakeFirst();
    return image ? { run, page, image } : undefined;
  }

  async findRun(runId: string) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();
  }

  async findRecentRuns(input: {
    workspaceId: string;
    spaceIds?: string[];
    limit: number;
  }) {
    let query = this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(Math.max(input.limit * 10, input.limit), 1_000));
    if (input.spaceIds?.length) {
      query = query.where('spaceId', 'in', input.spaceIds);
    }
    return query.execute();
  }
}

type BarrierState = {
  status: string;
  expectedPageCount: number;
  succeededPageCount: number;
  failedPageCount: number;
  skippedPageCount: number;
};

function sanitizeDiagnostic(value: string, maxLength: number): string {
  let normalized = '';
  let replacingControlSequence = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const isControl = code <= 0x1f || code === 0x7f;
    if (isControl) {
      if (!replacingControlSequence) normalized += ' ';
      replacingControlSequence = true;
    } else {
      normalized += character;
      replacingControlSequence = false;
    }
  }
  return normalized.trim().slice(0, maxLength);
}

function diagnosticValue(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  return value ? sanitizeDiagnostic(value, maxLength) : null;
}

function buildRunImageJobId(
  runId: string,
  runImageId: string,
  generation: number,
): string {
  return [
    'knowledge-compile-image',
    runId,
    runImageId,
    String(generation),
  ].join('__');
}
