import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@akasha/db/types/db';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
import { sql } from 'kysely';
import { reconcileRunPipelineInTransaction } from './knowledge-run-pipeline';
import {
  buildSpaceJobId,
  runPhaseToJobPhase,
} from './knowledge-space-execution.repo';

export type KnowledgeSpaceCompileRunStatus =
  | 'queued'
  | 'compiling'
  | 'aggregating'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'superseded'
  | 'cancelled';

export type KnowledgeSpaceCompileRunMode = 'incremental' | 'force_rebuild';

export type KnowledgeSpaceCompileRunPhase =
  | 'text'
  | 'images'
  | 'image_merge'
  | 'finalizing'
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
  targetSourcePageIds?: string[];
  pageIndexSetting?: {
    sourcePageId: string;
    indexMode: 'compiled' | 'original' | null;
    updatedBy: string | null;
  };
}

export const KNOWLEDGE_MANUAL_PAGE_PUBLISH_TRIGGER = 'manual_page_publish';
/** Force rebuild; exempt from the night compile window like page publish. */
export const KNOWLEDGE_MANUAL_RUN_TRIGGER = 'manual_run';

export type KnowledgePageCompileScheduleTrigger =
  | 'page_created'
  | 'page_updated'
  | 'page_restored';

export {
  reconcileRunTargetScope,
  reconcileFollowUpTargetScope,
  normalizeTargetSourcePageIds,
  parseTargetSourcePageIds,
} from './knowledge-run-scope';
import {
  normalizeTargetSourcePageIds,
  parseTargetSourcePageIds,
  reconcileFollowUpTargetScope,
  reconcileRunTargetScope,
} from './knowledge-run-scope';

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
  'aggregating',
];

const IMAGE_WORK_RUN_PHASES: KnowledgeSpaceCompileRunPhase[] = [
  'text',
  'images',
];
const IMAGE_WORK_RUN_STATUSES: KnowledgeSpaceCompileRunStatus[] = [
  'queued',
  'compiling',
];

@Injectable()
export class KnowledgeSpaceCompilationRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async findSpaceJobReservationCandidates(limit = 100) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .select([
        'id',
        'workspaceId',
        'spaceId',
        'phase',
        'trigger',
        'spaceJobQueuedAt',
      ])
      .where('status', '=', 'queued')
      .where('phase', 'in', ['text', 'finalizing'])
      .where('spaceJobId', 'is', null)
      .orderBy(
        sql<number>`CASE
          WHEN trigger = ${KNOWLEDGE_MANUAL_PAGE_PUBLISH_TRIGGER}
           AND phase IN ('text', 'finalizing') THEN 0
          WHEN phase = 'finalizing' THEN 1
          ELSE 5
        END`,
        'asc',
      )
      .orderBy('spaceJobQueuedAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
  }

  async findUndispatchedSpaceJobs(limit = 100) {
    const rows = await this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .select([
        'id',
        'workspaceId',
        'spaceId',
        'trigger',
        'phase',
        'knowledgeGeneration',
        'spaceJobSequence',
        'spaceJobId',
        'spaceJobQueuedAt',
      ])
      .where('status', '=', 'queued')
      .where('phase', 'in', ['text', 'finalizing'])
      .where('spaceJobId', 'is not', null)
      .where('spaceJobDispatchedAt', 'is', null)
      .orderBy(
        sql<number>`CASE
          WHEN trigger = ${KNOWLEDGE_MANUAL_PAGE_PUBLISH_TRIGGER}
           AND phase IN ('text', 'finalizing') THEN 0
          WHEN phase = 'finalizing' THEN 1
          ELSE 5
        END`,
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
      trigger: run.trigger,
      knowledgeGeneration: run.knowledgeGeneration,
      jobPhase: runPhaseToJobPhase(run.phase as KnowledgeSpaceCompileRunPhase),
      spaceJobSequence: run.spaceJobSequence,
      spaceJobId: run.spaceJobId!,
      spaceJobQueuedAt: run.spaceJobQueuedAt,
    }));
  }

  async markSpaceJobDispatched(input: {
    runId: string;
    knowledgeGeneration: number;
    jobPhase: 'text' | 'finalize';
    spaceJobSequence: number;
    spaceJobId: string;
  }): Promise<boolean> {
    const phases =
      input.jobPhase === 'text'
        ? (['text'] as const)
        : (['finalizing'] as const);
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

  async reserveNextSpaceJob(input: { runId: string }) {
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
      const spaceJobId = buildSpaceJobId(run.id, jobPhase, spaceJobSequence);
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
        await executeTx(this.db, (trx) =>
          this.requestRunInTx(trx, request, {
            compilerVersion: input.compilerVersion,
            promptVersion: input.promptVersion,
          }),
        ),
      );
    }
    return results;
  }

  /**
   * Records Space-level compilation requested outside the night compile
   * window. One durable intent per Space absorbs repeated clicks; it never
   * becomes a Run here, so the single-active-Run invariant is untouched.
   * The Space row is read without a lock: promotion locks intent -> schedule
   * -> Space, and taking the Space lock first here could deadlock with it.
   */
  async deferSpaceCompiles(input: {
    requests: Array<{
      workspaceId: string;
      spaceId: string;
      confirmationSpaceName?: string;
      scanRemovedSources?: boolean;
      requestedBy?: string | null;
    }>;
  }): Promise<
    Array<
      | { disposition: 'deferred'; spaceId: string }
      | {
          disposition: 'rejected';
          spaceId: string;
          reason: 'space_not_found' | 'space_name_mismatch';
        }
    >
  > {
    const results = [];
    for (const request of input.requests) {
      const space = await this.db
        .selectFrom('spaces')
        .select(['id', 'name'])
        .where('id', '=', request.spaceId)
        .where('workspaceId', '=', request.workspaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!space) {
        results.push({
          disposition: 'rejected' as const,
          spaceId: request.spaceId,
          reason: 'space_not_found' as const,
        });
        continue;
      }
      if (
        request.confirmationSpaceName !== undefined &&
        request.confirmationSpaceName !== space.name
      ) {
        results.push({
          disposition: 'rejected' as const,
          spaceId: request.spaceId,
          reason: 'space_name_mismatch' as const,
        });
        continue;
      }
      const scanRemovedSources = request.scanRemovedSources === true;
      await sql`
        INSERT INTO knowledge_space_deferred_compiles (
          workspace_id,
          space_id,
          scan_removed_sources,
          request_count,
          requested_by,
          first_requested_at,
          last_requested_at,
          created_at,
          updated_at
        )
        VALUES (
          ${request.workspaceId},
          ${request.spaceId},
          ${scanRemovedSources},
          1,
          ${request.requestedBy ?? null},
          clock_timestamp(),
          clock_timestamp(),
          clock_timestamp(),
          clock_timestamp()
        )
        ON CONFLICT (workspace_id, space_id) DO UPDATE
        SET scan_removed_sources =
              knowledge_space_deferred_compiles.scan_removed_sources
              OR EXCLUDED.scan_removed_sources,
            request_count = knowledge_space_deferred_compiles.request_count + 1,
            requested_by = COALESCE(
              EXCLUDED.requested_by,
              knowledge_space_deferred_compiles.requested_by
            ),
            last_requested_at = greatest(
              knowledge_space_deferred_compiles.last_requested_at,
              EXCLUDED.last_requested_at
            ),
            updated_at = EXCLUDED.updated_at
      `.execute(this.db);
      results.push({
        disposition: 'deferred' as const,
        spaceId: request.spaceId,
      });
    }
    return results;
  }

  /**
   * Turns deferred Space intents of open workspaces into ordinary
   * manual_compile Run requests. Each intent is promoted and deleted in its
   * own transaction (a full-Space request may scan removed sources). The
   * request covers the whole Space, so requestRunInTx also clears that
   * Space's delayed page schedules: the Run compiles every page anyway.
   */
  async promoteDeferredSpaceCompiles(input: {
    compilerVersion: string;
    promptVersion: string;
    limit?: number;
    excludedWorkspaceIds?: string[];
  }): Promise<{ selectedCount: number; runRequestCount: number }> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    let candidates = this.db
      .selectFrom('knowledgeSpaceDeferredCompiles')
      .select('id');
    if (input.excludedWorkspaceIds?.length) {
      candidates = candidates.where(
        'workspaceId',
        'not in',
        input.excludedWorkspaceIds,
      );
    }
    const rows = await candidates
      .orderBy('firstRequestedAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    let runRequestCount = 0;
    for (const row of rows) {
      const promoted = await executeTx(this.db, async (trx) => {
        const intent = await trx
          .selectFrom('knowledgeSpaceDeferredCompiles')
          .select(['id', 'workspaceId', 'spaceId', 'scanRemovedSources'])
          .where('id', '=', row.id)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!intent) return false;
        const result = await this.requestRunInTx(
          trx,
          {
            workspaceId: intent.workspaceId,
            spaceId: intent.spaceId,
            trigger: 'manual_compile',
            scanRemovedSources: intent.scanRemovedSources,
          },
          input,
        );
        // A deleted Space rejects the request; its intent is dropped too.
        await trx
          .deleteFrom('knowledgeSpaceDeferredCompiles')
          .where('id', '=', intent.id)
          .execute();
        return result.disposition !== 'rejected';
      });
      if (promoted) runRequestCount += 1;
    }
    return { selectedCount: rows.length, runRequestCount };
  }

  /**
   * Adds or postpones page-level automatic compilation. The unique page row
   * is the durable trailing-debounce state, so every later edit moves the
   * eligibility time forward without creating a Space Run or Redis job.
   */
  async scheduleIncrementalCompileForPages(input: {
    workspaceId: string;
    sourcePageIds: string[];
    trigger: KnowledgePageCompileScheduleTrigger;
    quietPeriodMs: number;
    changedAt?: Date;
  }): Promise<number> {
    const sourcePageIds = [...new Set(input.sourcePageIds)];
    if (sourcePageIds.length === 0) return 0;
    const quietPeriodMs = Math.max(0, input.quietPeriodMs);
    // Production scheduling uses the database clock so application-instance
    // clock skew cannot shorten a quiet period. Tests may inject changedAt.
    const changedAt = input.changedAt
      ? sql<Date>`${input.changedAt}`
      : sql<Date>`clock_timestamp()`;
    const eligibleAt = input.changedAt
      ? sql<Date>`${new Date(input.changedAt.getTime() + quietPeriodMs)}`
      : sql<Date>`clock_timestamp() + (${quietPeriodMs} * interval '1 millisecond')`;
    const scheduled = await sql<{ id: string }>`
      INSERT INTO knowledge_page_compile_schedules (
        workspace_id,
        space_id,
        source_page_id,
        trigger,
        change_count,
        first_changed_at,
        last_changed_at,
        eligible_at,
        created_at,
        updated_at
      )
      SELECT
        page.workspace_id,
        page.space_id,
        page.id,
        ${input.trigger},
        1,
        ${changedAt},
        ${changedAt},
        ${eligibleAt},
        ${changedAt},
        ${changedAt}
      FROM pages AS page
      INNER JOIN spaces AS space
        ON space.id = page.space_id
       AND space.workspace_id = page.workspace_id
       AND space.deleted_at IS NULL
      WHERE page.workspace_id = ${input.workspaceId}
        AND page.id IN (${sql.join(sourcePageIds)})
        AND page.deleted_at IS NULL
      ON CONFLICT (workspace_id, source_page_id) DO UPDATE
      SET space_id = EXCLUDED.space_id,
          trigger = EXCLUDED.trigger,
          change_count = knowledge_page_compile_schedules.change_count + 1,
          last_changed_at = greatest(
            knowledge_page_compile_schedules.last_changed_at,
            EXCLUDED.last_changed_at
          ),
          eligible_at = greatest(
            knowledge_page_compile_schedules.eligible_at,
            EXCLUDED.eligible_at
          ),
          updated_at = greatest(
            knowledge_page_compile_schedules.updated_at,
            EXCLUDED.updated_at
          )
      RETURNING id
    `.execute(this.db);
    return scheduled.rows.length;
  }

  /** Sets one confirmed delayed page due now; later edits can postpone it. */
  async markDelayedPageForImmediateCompilation(input: {
    workspaceId: string;
    scheduleId: string;
    confirmationPageName: string;
  }): Promise<{
    scheduleId: string;
    sourcePageId: string;
    spaceId: string;
    pageName: string;
  } | null> {
    const updated = await sql<{
      scheduleId: string;
      sourcePageId: string;
      spaceId: string;
      pageName: string;
    }>`
      UPDATE knowledge_page_compile_schedules AS schedule
      SET eligible_at = clock_timestamp(),
          updated_at = clock_timestamp()
      FROM pages AS source_page, spaces AS space
      WHERE schedule.id = ${input.scheduleId}
        AND schedule.workspace_id = ${input.workspaceId}
        AND source_page.id = schedule.source_page_id
        AND source_page.workspace_id = schedule.workspace_id
        AND source_page.deleted_at IS NULL
        AND space.id = schedule.space_id
        AND space.workspace_id = schedule.workspace_id
        AND space.deleted_at IS NULL
        AND COALESCE(
          NULLIF(source_page.title, ''),
          source_page.slug_id,
          source_page.id::text
        ) = ${input.confirmationPageName}
      RETURNING schedule.id AS "scheduleId",
                schedule.source_page_id AS "sourcePageId",
                schedule.space_id AS "spaceId",
                COALESCE(
                  NULLIF(source_page.title, ''),
                  source_page.slug_id,
                  source_page.id::text
                ) AS "pageName"
    `.execute(this.db);
    return updated.rows[0] ?? null;
  }

  /** Removes one confirmed page from the delayed compilation queue. */
  async removeDelayedPageCompilation(input: {
    workspaceId: string;
    scheduleId: string;
    confirmationPageName: string;
  }): Promise<{
    scheduleId: string;
    sourcePageId: string;
    spaceId: string;
    pageName: string;
  } | null> {
    const deleted = await sql<{
      scheduleId: string;
      sourcePageId: string;
      spaceId: string;
      pageName: string;
    }>`
      DELETE FROM knowledge_page_compile_schedules AS schedule
      USING pages AS source_page, spaces AS space
      WHERE schedule.id = ${input.scheduleId}
        AND schedule.workspace_id = ${input.workspaceId}
        AND source_page.id = schedule.source_page_id
        AND source_page.workspace_id = schedule.workspace_id
        AND source_page.deleted_at IS NULL
        AND space.id = schedule.space_id
        AND space.workspace_id = schedule.workspace_id
        AND space.deleted_at IS NULL
        AND COALESCE(
          NULLIF(source_page.title, ''),
          source_page.slug_id,
          source_page.id::text
        ) = ${input.confirmationPageName}
      RETURNING schedule.id AS "scheduleId",
                schedule.source_page_id AS "sourcePageId",
                schedule.space_id AS "spaceId",
                COALESCE(
                  NULLIF(source_page.title, ''),
                  source_page.slug_id,
                  source_page.id::text
                ) AS "pageName"
    `.execute(this.db);
    return deleted.rows[0] ?? null;
  }

  /**
   * Atomically promotes due page schedules into page-scoped Space Runs. The
   * schedule rows and Run request share one PostgreSQL transaction, while
   * SKIP LOCKED lets multiple application instances drain disjoint batches.
   */
  async promoteDuePageCompileSchedules(input: {
    compilerVersion: string;
    promptVersion: string;
    limit?: number;
    now?: Date;
    /**
     * Workspaces outside their night compile window. Filtered in SQL: the
     * batch is LIMITed with SKIP LOCKED, so skipping gated rows afterwards
     * would let them fill every batch and starve open workspaces.
     */
    excludedWorkspaceIds?: string[];
  }): Promise<{
    selectedPageCount: number;
    promotedPageCount: number;
    runRequestCount: number;
  }> {
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 2_000);
    return executeTx(this.db, async (trx) => {
      const dueAt = input.now
        ? sql<Date>`${input.now}`
        : sql<Date>`clock_timestamp()`;
      let due = trx
        .selectFrom('knowledgePageCompileSchedules')
        .select(['id', 'workspaceId', 'sourcePageId'])
        .where('eligibleAt', '<=', dueAt);
      if (input.excludedWorkspaceIds?.length) {
        due = due.where('workspaceId', 'not in', input.excludedWorkspaceIds);
      }
      const schedules = await due
        .orderBy('eligibleAt', 'asc')
        .orderBy('id', 'asc')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      if (schedules.length === 0) {
        return {
          selectedPageCount: 0,
          promotedPageCount: 0,
          runRequestCount: 0,
        };
      }

      const pageIds = schedules.map((schedule) => schedule.sourcePageId);
      const validPages = await trx
        .selectFrom('pages as page')
        .innerJoin('spaces as space', (join) =>
          join
            .onRef('space.id', '=', 'page.spaceId')
            .onRef('space.workspaceId', '=', 'page.workspaceId'),
        )
        .select(['page.workspaceId', 'page.spaceId', 'page.id'])
        .where('page.id', 'in', pageIds)
        .where('page.deletedAt', 'is', null)
        .where('space.deletedAt', 'is', null)
        .execute();
      const pagesByScope = new Map<string, typeof validPages>();
      for (const page of validPages) {
        const key = `${page.workspaceId}:${page.spaceId}`;
        const pages = pagesByScope.get(key) ?? [];
        pages.push(page);
        pagesByScope.set(key, pages);
      }

      // Lock Spaces in a deterministic order to avoid cross-instance
      // deadlocks when a large due batch spans several Spaces.
      const scopes = [...pagesByScope.values()].sort((left, right) => {
        const a = `${left[0].workspaceId}:${left[0].spaceId}`;
        const b = `${right[0].workspaceId}:${right[0].spaceId}`;
        return a.localeCompare(b);
      });
      let runRequestCount = 0;
      for (const pages of scopes) {
        const page = pages[0];
        const result = await this.requestRunInTx(
          trx,
          {
            workspaceId: page.workspaceId,
            spaceId: page.spaceId,
            trigger: 'debounced_page_change',
            targetSourcePageIds: pages.map((item) => item.id),
          },
          input,
        );
        if (result.disposition !== 'rejected') runRequestCount += 1;
      }

      // Invalid/deleted pages are discarded too. Valid rows have normally
      // already been removed by requestRunInTx; the exact-ID delete is
      // intentionally idempotent.
      await trx
        .deleteFrom('knowledgePageCompileSchedules')
        .where(
          'id',
          'in',
          schedules.map((schedule) => schedule.id),
        )
        .execute();
      return {
        selectedPageCount: schedules.length,
        promotedPageCount: validPages.length,
        runRequestCount,
      };
    });
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
          : { targetSourcePageIds: [...new Set(sourcePageIds)] }),
      })),
      compilerVersion: input.compilerVersion,
      promptVersion: input.promptVersion,
    });
  }

  private async requestRunInTx(
    trx: KyselyTransaction,
    request: SpaceRunRequest,
    versions: { compilerVersion: string; promptVersion: string },
  ) {
    const now = new Date();
    const requestTargetSourcePageIds = normalizeTargetSourcePageIds(
      request.targetSourcePageIds,
    );
    // Delayed schedule rows are always locked before the Space row. Force
    // rebuild follows the same order, preventing a promotion/manual-request
    // deadlock across application instances.
    await this.lockScheduledPagesCoveredByRequest(
      trx,
      request,
      requestTargetSourcePageIds,
    );
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

    const pageScoped = requestTargetSourcePageIds !== null;

    if (request.pageIndexSetting) {
      const setting = request.pageIndexSetting;
      const page = await trx
        .selectFrom('pages')
        .select('id')
        .where('id', '=', setting.sourcePageId)
        .where('workspaceId', '=', request.workspaceId)
        .where('spaceId', '=', request.spaceId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!page) throw new Error('Knowledge source page is unavailable.');
      if (setting.indexMode === null) {
        await trx
          .deleteFrom('knowledgePageIndexSettings')
          .where('workspaceId', '=', request.workspaceId)
          .where('sourcePageId', '=', setting.sourcePageId)
          .execute();
      } else {
        const indexMode = setting.indexMode;
        await trx
          .insertInto('knowledgePageIndexSettings')
          .values({
            workspaceId: request.workspaceId,
            sourcePageId: setting.sourcePageId,
            indexMode,
            updatedBy: setting.updatedBy,
            updatedAt: now,
          })
          .onConflict((oc) =>
            oc.columns(['workspaceId', 'sourcePageId']).doUpdateSet({
              indexMode,
              updatedBy: setting.updatedBy,
              updatedAt: now,
            }),
          )
          .execute();
      }
    }

    let activeRun = await trx
      .selectFrom('knowledgeSpaceCompileRuns')
      .selectAll()
      .where('workspaceId', '=', request.workspaceId)
      .where('spaceId', '=', request.spaceId)
      .where('status', 'in', NONTERMINAL_RUN_STATUSES)
      .forUpdate()
      .executeTakeFirst();

    // A page-scoped Run must not scan the whole Space for removed sources: it
    // only knows about its target pages, and a Space-wide scan would wrongly
    // retire every page it did not export.
    const removedSourcePageIds = pageScoped
      ? []
      : await this.resolveRemovedSourcePageIds(trx, request);
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
      const scope = reconcileRunTargetScope({
        runTargetSourcePageIds: parseTargetSourcePageIds(
          activeRun!.targetSourcePageIds,
        ),
        requestTargetSourcePageIds: requestTargetSourcePageIds ?? undefined,
      });
      const shouldPromoteTrigger =
        request.trigger === KNOWLEDGE_MANUAL_PAGE_PUBLISH_TRIGGER &&
        activeRun!.trigger !== KNOWLEDGE_MANUAL_PAGE_PUBLISH_TRIGGER;
      let run = activeRun!;
      if (scope.changed || shouldPromoteTrigger) {
        run =
          (await trx
            .updateTable('knowledgeSpaceCompileRuns')
            .set({
              ...(scope.changed
                ? {
                    targetSourcePageIds:
                      scope.targetSourcePageIds as JsonValue | null,
                  }
                : {}),
              ...(shouldPromoteTrigger ? { trigger: request.trigger } : {}),
              updatedAt: now,
            })
            .where('id', '=', activeRun!.id)
            .where('status', 'in', NONTERMINAL_RUN_STATUSES)
            .returningAll()
            .executeTakeFirst()) ?? activeRun!;
      }
      await this.clearScheduledPagesCoveredByRequest(
        trx,
        request,
        requestTargetSourcePageIds,
      );
      return { disposition, run };
    }
    if (disposition === 'rerun_requested') {
      // The active Run has already frozen its RunPages, so newly changed
      // pages belong to the follow-up. Persist the union separately from the
      // current Run's immutable discovery scope and let finishRun() carry it
      // forward.
      const scope = reconcileFollowUpTargetScope({
        followUpTargetSourcePageIds: parseTargetSourcePageIds(
          activeRun!.followUpTargetSourcePageIds,
        ),
        requestTargetSourcePageIds: requestTargetSourcePageIds ?? undefined,
        rerunAlreadyRequested: activeRun!.rerunRequested,
      });
      const run = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          rerunRequested: true,
          ...(scope.changed
            ? {
                followUpTargetSourcePageIds:
                  scope.targetSourcePageIds as JsonValue | null,
              }
            : {}),
          updatedAt: now,
        })
        .where('id', '=', activeRun!.id)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .returningAll()
        .executeTakeFirst();
      await this.clearScheduledPagesCoveredByRequest(
        trx,
        request,
        requestTargetSourcePageIds,
      );
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
        compilerVersion: versions.compilerVersion,
        promptVersion: versions.promptVersion,
        targetSourcePageIds: requestTargetSourcePageIds as JsonValue | null,
        queuedAt: now,
        spaceJobQueuedAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.clearScheduledPagesCoveredByRequest(
      trx,
      request,
      requestTargetSourcePageIds,
    );
    return { disposition, run };
  }

  /** Immediate/manual work supersedes delayed page rows it already covers. */
  private async lockScheduledPagesCoveredByRequest(
    trx: KyselyTransaction,
    request: SpaceRunRequest,
    targetSourcePageIds: string[] | null,
  ): Promise<void> {
    let query = trx
      .selectFrom('knowledgePageCompileSchedules')
      .select('id')
      .where('workspaceId', '=', request.workspaceId)
      .where('spaceId', '=', request.spaceId);
    if (targetSourcePageIds) {
      query = query.where('sourcePageId', 'in', targetSourcePageIds);
    }
    await query
      .orderBy('eligibleAt', 'asc')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();
  }

  /** Immediate/manual work supersedes delayed page rows it already covers. */
  private async clearScheduledPagesCoveredByRequest(
    trx: KyselyTransaction,
    request: SpaceRunRequest,
    targetSourcePageIds: string[] | null,
  ): Promise<void> {
    let deletion = trx
      .deleteFrom('knowledgePageCompileSchedules')
      .where('workspaceId', '=', request.workspaceId)
      .where('spaceId', '=', request.spaceId);
    if (targetSourcePageIds) {
      deletion = deletion.where('sourcePageId', 'in', targetSourcePageIds);
    }
    await deletion.execute();
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
    const artifactIds = [
      ...new Set(affectedArtifacts.map((row) => row.artifactId)),
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
        ['knowledgeChunks', 'knowledgePageId'],
        ['knowledgeLinks', 'fromKnowledgePageId'],
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
      // Match deferred promotion's lock order: intent -> schedules -> Space.
      const deferredCompile = await trx
        .selectFrom('knowledgeSpaceDeferredCompiles')
        .select('id')
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .forUpdate()
        .executeTakeFirst();
      await trx
        .selectFrom('knowledgePageCompileSchedules')
        .select('id')
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .orderBy('eligibleAt', 'asc')
        .orderBy('id', 'asc')
        .forUpdate()
        .execute();
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

      // The rebuild supersedes the intent locked above. Clear only that ID so
      // requests inserted concurrently after the lookup remain queued.
      if (deferredCompile) {
        await trx
          .deleteFrom('knowledgeSpaceDeferredCompiles')
          .where('id', '=', deferredCompile.id)
          .execute();
      }

      // The immediate rebuild covers the latest version of every page in the
      // Space, so any delayed automatic work is redundant.
      await trx
        .deleteFrom('knowledgePageCompileSchedules')
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .execute();

      const oldRuns = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .select(['id', 'spaceJobId', 'aggregateJobId'])
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .forUpdate()
        .execute();
      const oldRunIds = oldRuns.map((run) => run.id);
      const supersededMessage =
        'A force rebuild replaced this knowledge compilation run.';
      const {
        pages: oldPages,
        images: oldImages,
        countsByRun,
      } = await this.terminalizeInterruptedRunChildren(trx, {
        runIds: oldRunIds,
        errorCode: 'run_superseded',
        errorMessage: supersededMessage,
        now,
      });
      // All old runs belong to the same locked Space. Update them in one
      // statement so a force rebuild does not hold the transaction open for
      // one round trip per stale Run when recovery has left multiple active
      // generations behind.
      if (oldRuns.length > 0) {
        await sql`
        UPDATE knowledge_space_compile_runs AS run
        SET
          status = 'superseded',
          phase = 'complete',
          succeeded_page_count = counts.succeeded,
          failed_page_count = counts.failed,
          skipped_page_count = counts.skipped,
          error_code = 'run_superseded',
          error_message = ${supersededMessage},
          rerun_requested = false,
          aggregate_job_id = NULL,
          space_job_id = NULL,
          space_job_queued_at = NULL,
          space_job_dispatched_at = NULL,
          execution_token = NULL,
          execution_lease_expires_at = NULL,
          worker_id = NULL,
          heartbeat_at = NULL,
          finished_at = ${now},
          updated_at = ${now}
        FROM (VALUES ${sql.join(
          oldRuns.map((oldRun) => {
            const counts = countsByRun.get(oldRun.id)!;
            return sql`(
              ${oldRun.id},
              ${counts.succeeded},
              ${counts.failed},
              ${counts.skipped}
            )`;
          }),
        )}) AS counts(id, succeeded, failed, skipped)
        WHERE run.id = counts.id
          AND run.status IN (${sql.join(
            NONTERMINAL_RUN_STATUSES.map((status) => sql`${status}`),
          )})
        `.execute(trx);
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
          status: 'queued',
          expectedPageCount: input.deferInitialization
            ? 0
            : input.sources.length,
          compilerVersion: input.compilerVersion,
          promptVersion: input.promptVersion,
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
        ...oldRuns.map((oldRun) => oldRun.spaceJobId),
        ...oldRuns.map((oldRun) => oldRun.aggregateJobId),
        ...oldPages.flatMap((page) => [page.jobId, page.mergeJobId]),
        ...oldImages.map((image) => image.jobId),
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
      .where('run.phase', 'in', IMAGE_WORK_RUN_PHASES)
      .where('run.status', 'in', IMAGE_WORK_RUN_STATUSES)
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
      .where('run.phase', 'in', IMAGE_WORK_RUN_PHASES)
      .where('run.status', 'in', IMAGE_WORK_RUN_STATUSES)
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
          .where('phase', 'in', IMAGE_WORK_RUN_PHASES)
          .where('status', 'in', IMAGE_WORK_RUN_STATUSES),
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
        'image.status',
        'image.dispatchedAt',
        'image.processingExpiresAt',
        'image.redisRecoveryCount',
        'run.knowledgeGeneration',
      ])
      .where('image.jobId', 'is not', null)
      .where('run.phase', 'in', IMAGE_WORK_RUN_PHASES)
      .where('run.status', 'in', IMAGE_WORK_RUN_STATUSES)
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
    observedStatus: 'queued' | 'processing';
    processingExpiredBefore: Date;
    queuedDispatchedBefore: Date;
  }): Promise<boolean> {
    return executeTx(this.db, async (trx) => {
      const locked = await this.lockRunImageIdentity(trx, input);
      const recoveryWindowStillValid =
        input.observedStatus === 'queued'
          ? locked?.image.status === 'queued' &&
            locked.image.dispatchedAt !== null &&
            locked.image.dispatchedAt < input.queuedDispatchedBefore
          : locked?.image.status === 'processing' &&
            locked.image.processingExpiresAt !== null &&
            locked.image.processingExpiresAt < input.processingExpiredBefore;
      if (
        !locked ||
        !recoveryWindowStillValid ||
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
        .where('status', '=', input.observedStatus)
        .$if(input.observedStatus === 'queued', (query) =>
          query
            .where('dispatchedAt', 'is not', null)
            .where('dispatchedAt', '<', input.queuedDispatchedBefore),
        )
        .$if(input.observedStatus === 'processing', (query) =>
          query
            .where('processingExpiresAt', 'is not', null)
            .where('processingExpiresAt', '<', input.processingExpiredBefore),
        )
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
      const processing = children.filter(
        (child) => child.status === 'processing',
      ).length;
      const queued = children.filter(
        (child) => child.status === 'queued',
      ).length;
      const pending = children.filter(
        (child) => child.status === 'pending',
      ).length;
      const nonterminal = processing + queued + pending;
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
        processing > 0
          ? 'processing'
          : queued > 0
            ? 'queued'
            : pending > 0
              ? 'pending'
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
          ...(['partial', 'failed'].includes(imageStatus)
            ? { qualityStatus: 'partial_image' as const }
            : {}),
          // Once every image is terminal we always hand the page to the merge
          // phase, even when all extractions failed. The merge build is the
          // single compile point for image pages: with no ready images it
          // falls back to text-only (so a page with text still yields
          // knowledge) or skips an empty page without replacing prior
          // knowledge. Gating on succeeded > 0 here would strand text-bearing
          // pages whose images all failed.
          ...(nonterminal === 0 ? { mergeStatus: 'pending' as const } : {}),
          updatedAt: now,
        })
        .where('id', '=', locked.page.id)
        .where('imageStatus', 'in', ['pending', 'queued', 'processing'])
        .execute();

      const reconciled = await reconcileRunPipelineInTransaction(
        trx,
        input.runId,
      );
      const barrierAdvanced = Boolean(
        reconciled && reconciled.phase !== locked.run.phase,
      );
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
        .where('phase', 'in', IMAGE_WORK_RUN_PHASES)
        .where('status', 'in', IMAGE_WORK_RUN_STATUSES)
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
      .where('phase', 'in', IMAGE_WORK_RUN_PHASES)
      .where('status', 'in', IMAGE_WORK_RUN_STATUSES)
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

  /**
   * Closes every unfinished child dimension for Runs that are being stopped
   * by an explicit control-plane transaction. Callers must already hold the
   * Space and Run locks; this method completes the global lock order with
   * RunPage -> RunImage and returns every exact child Job ID for post-commit
   * Redis cleanup.
   */
  private async terminalizeInterruptedRunChildren(
    trx: KyselyTransaction,
    input: {
      runIds: string[];
      errorCode: string;
      errorMessage: string | null;
      now: Date;
    },
  ) {
    const countsByRun = new Map<
      string,
      { succeeded: number; failed: number; skipped: number }
    >();
    for (const runId of input.runIds) {
      countsByRun.set(runId, { succeeded: 0, failed: 0, skipped: 0 });
    }
    if (input.runIds.length === 0) {
      return { pages: [], images: [], countsByRun };
    }

    const pages = await trx
      .selectFrom('knowledgeSpaceCompileRunPages')
      .select(['id', 'runId', 'status', 'jobId', 'mergeJobId'])
      .where('runId', 'in', input.runIds)
      .orderBy('runId', 'asc')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();
    const images = await trx
      .selectFrom('knowledgeSpaceCompileRunImages')
      .select(['id', 'runId', 'jobId'])
      .where('runId', 'in', input.runIds)
      .orderBy('runId', 'asc')
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();

    await trx
      .updateTable('knowledgeSpaceCompileRunImages')
      .set({
        status: 'skipped',
        failureClass: null,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        processingExpiresAt: null,
        updatedAt: input.now,
      })
      .where('runId', 'in', input.runIds)
      .where('status', 'in', ['pending', 'queued', 'processing'])
      .execute();

    await trx
      .updateTable('knowledgeSpaceCompileRunPages')
      .set({
        status: 'skipped',
        errorCode: sql`COALESCE(error_code, ${input.errorCode})`,
        errorMessage: sql`COALESCE(error_message, ${input.errorMessage})`,
        finishedAt: input.now,
        updatedAt: input.now,
      })
      .where('runId', 'in', input.runIds)
      .where('status', 'in', ['pending', 'queued', 'running'])
      .execute();

    await sql`
      WITH image_counts AS (
        SELECT
          run_page_id,
          COUNT(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded,
          COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed,
          BOOL_OR(
            status = 'failed' AND failure_class = 'retryable_exhausted'
          ) AS has_retryable_exhausted
        FROM knowledge_space_compile_run_images
        WHERE run_id IN (${sql.join(input.runIds)})
        GROUP BY run_page_id
      )
      UPDATE knowledge_space_compile_run_pages AS page
      SET
        succeeded_image_count = counts.succeeded,
        failed_image_count = counts.failed,
        skipped_image_count = GREATEST(
          page.expected_image_count - counts.succeeded - counts.failed,
          0
        ),
        image_status = CASE
          WHEN counts.has_retryable_exhausted THEN 'failed'
          WHEN counts.failed > 0 OR
               page.expected_image_count - counts.succeeded - counts.failed > 0
            THEN 'partial'
          ELSE 'succeeded'
        END,
        updated_at = ${input.now}
      FROM image_counts AS counts
      WHERE page.id = counts.run_page_id
        AND page.run_id IN (${sql.join(input.runIds)})
        AND page.image_status IN ('pending', 'queued', 'processing')
    `.execute(trx);

    // RunPages may exist before the RunImage snapshot is inserted. They are
    // absent from image_counts but still must become terminal.
    await trx
      .updateTable('knowledgeSpaceCompileRunPages')
      .set({
        skippedImageCount: sql`GREATEST(
          expected_image_count - succeeded_image_count - failed_image_count,
          0
        )`,
        imageStatus: sql`CASE
          WHEN expected_image_count = 0 THEN 'not_required'
          ELSE 'partial'
        END`,
        updatedAt: input.now,
      })
      .where('runId', 'in', input.runIds)
      .where('imageStatus', 'in', ['pending', 'queued', 'processing'])
      .execute();

    await trx
      .updateTable('knowledgeSpaceCompileRunPages')
      .set({
        mergeStatus: 'skipped',
        // Clear the page merge execution fence so any stale merge worker that
        // returns after cancellation fails its publication guard.
        mergeExecutionToken: null,
        mergeProcessingExpiresAt: null,
        mergeWorkerId: null,
        mergeHeartbeatAt: null,
        errorCode: sql`COALESCE(error_code, ${input.errorCode})`,
        errorMessage: sql`COALESCE(error_message, ${input.errorMessage})`,
        updatedAt: input.now,
      })
      .where('runId', 'in', input.runIds)
      .where('mergeStatus', 'in', [
        'waiting_images',
        'pending',
        'queued',
        'running',
      ])
      .execute();

    for (const page of pages) {
      const counts = countsByRun.get(page.runId)!;
      const status = ['pending', 'queued', 'running'].includes(page.status)
        ? 'skipped'
        : page.status;
      if (status === 'succeeded') counts.succeeded += 1;
      if (status === 'failed') counts.failed += 1;
      if (status === 'skipped') counts.skipped += 1;
    }
    return { pages, images, countsByRun };
  }

  /**
   * Administratively stops one exact Run. The database transaction is the
   * authoritative cancellation boundary; callers may remove the returned
   * exact BullMQ jobs only after it commits. Already published knowledge is
   * intentionally retained.
   */
  async cancelRun(input: {
    workspaceId: string;
    runId: string;
    reason?: string;
  }) {
    return executeTx(this.db, async (trx) => {
      // The identity read takes no lock. Every multi-table lock that follows
      // obeys the global spaces -> Run -> RunPage -> RunImage order.
      const identity = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .select(['spaceId'])
        .where('id', '=', input.runId)
        .where('workspaceId', '=', input.workspaceId)
        .executeTakeFirst();
      if (!identity) return { disposition: 'not_found' as const };

      const space = await trx
        .selectFrom('spaces')
        .select('id')
        .where('id', '=', identity.spaceId)
        .where('workspaceId', '=', input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!space) return { disposition: 'not_found' as const };

      const run = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .selectAll()
        .where('id', '=', input.runId)
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', identity.spaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!run) return { disposition: 'not_found' as const };
      if (
        !NONTERMINAL_RUN_STATUSES.includes(
          run.status as KnowledgeSpaceCompileRunStatus,
        )
      ) {
        return {
          disposition: 'already_terminal' as const,
          run,
          jobIds: [],
        };
      }

      const now = new Date();
      const errorMessage = diagnosticValue(
        input.reason
          ? `Knowledge compilation was cancelled: ${input.reason}`
          : 'Knowledge compilation was cancelled by an administrator.',
        500,
      );
      const { pages, images, countsByRun } =
        await this.terminalizeInterruptedRunChildren(trx, {
          runIds: [input.runId],
          errorCode: 'manual_cancelled',
          errorMessage,
          now,
        });
      const counts = countsByRun.get(input.runId)!;

      const cancelled = await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          status: 'cancelled',
          phase: 'complete',
          succeededPageCount: counts.succeeded,
          failedPageCount: counts.failed,
          skippedPageCount: counts.skipped,
          errorCode: 'manual_cancelled',
          errorMessage,
          rerunRequested: false,
          aggregateJobId: null,
          spaceJobId: null,
          spaceJobQueuedAt: null,
          spaceJobDispatchedAt: null,
          executionToken: null,
          executionLeaseExpiresAt: null,
          workerId: null,
          heartbeatAt: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where('id', '=', input.runId)
        .where('workspaceId', '=', input.workspaceId)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .returningAll()
        .executeTakeFirstOrThrow();

      const jobIds = [
        run.spaceJobId,
        run.aggregateJobId,
        ...pages.flatMap((page) => [page.jobId, page.mergeJobId]),
        ...images.map((image) => image.jobId),
      ].filter((jobId): jobId is string => Boolean(jobId));
      return {
        disposition: 'cancelled' as const,
        previousStatus: run.status as KnowledgeSpaceCompileRunStatus,
        previousPhase: run.phase as KnowledgeSpaceCompileRunPhase,
        run: cancelled,
        jobIds: [...new Set(jobIds)],
      };
    });
  }

  async findRun(runId: string) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();
  }

  /** Returns the most recent compilation RunPage for a source page. */
  async findLatestPageCompileStatus(input: {
    workspaceId: string;
    sourcePageId: string;
  }) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRunPages as page')
      .innerJoin('knowledgeSpaceCompileRuns as run', 'run.id', 'page.runId')
      .select([
        'page.status as pageStatus',
        'page.errorMessage as errorMessage',
        'page.startedAt as startedAt',
        'page.finishedAt as finishedAt',
        'page.expectedSourceVersion as sourceVersion',
        'run.id as runId',
        'run.status as runStatus',
        'run.phase as runPhase',
        'run.updatedAt as runUpdatedAt',
      ])
      .where('page.workspaceId', '=', input.workspaceId)
      .where('page.sourcePageId', '=', input.sourcePageId)
      .orderBy('page.updatedAt', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** Finds an active page-scoped Run even before its RunPage rows are bound. */
  async findActiveRunForPage(input: {
    workspaceId: string;
    spaceId: string;
    sourcePageId: string;
  }) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .selectAll()
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('status', 'in', NONTERMINAL_RUN_STATUSES)
      .where(
        sql<boolean>`target_source_page_ids @> ${JSON.stringify([input.sourcePageId])}::jsonb`,
      )
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
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
