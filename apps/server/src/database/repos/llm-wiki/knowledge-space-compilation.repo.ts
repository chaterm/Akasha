import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@akasha/db/types/db';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
import { sql } from 'kysely';

export type KnowledgeSpaceCompileRunStatus =
  | 'queued'
  | 'compiling'
  | 'aggregate_pending'
  | 'aggregating'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'superseded';

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

  async createRun(input: {
    workspaceId: string;
    spaceId: string;
    trigger: string;
    compilerVersion: string;
    promptVersion: string;
    catalogSnapshot: JsonValue;
    catalogHash: string;
    requestedAt?: Date;
    sources: Array<{
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
    }>;
  }) {
    return executeTx(this.db, async (trx) => {
      const now = new Date();

      // All full-space run creators lock the same durable row. This closes the
      // race between multiple API replicas before the partial unique index is
      // reached, while the index remains a final database-level guard.
      await trx
        .selectFrom('spaces')
        .select('id')
        .where('id', '=', input.spaceId)
        .where('workspaceId', '=', input.workspaceId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (input.requestedAt) {
        const newerRun = await trx
          .selectFrom('knowledgeSpaceCompileRuns')
          .selectAll()
          .where('workspaceId', '=', input.workspaceId)
          .where('spaceId', '=', input.spaceId)
          .where('queuedAt', '>', input.requestedAt)
          .orderBy('queuedAt', 'desc')
          .executeTakeFirst();
        if (newerRun) {
          return {
            created: false as const,
            run: newerRun,
            supersededRunIds: [],
            supersededJobIds: [],
          };
        }
      }

      const supersededRuns = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .select(['id', 'aggregateJobId', 'skippedPageCount'])
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .forUpdate()
        .execute();

      const supersededRunIds = supersededRuns.map((run) => run.id);
      const supersededPages =
        supersededRunIds.length === 0
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
              .where('runId', 'in', supersededRunIds)
              .where('status', 'in', ['pending', 'queued', 'running'])
              .returning(['runId', 'jobId'])
              .execute();

      const skippedByRun = new Map<string, number>();
      for (const page of supersededPages) {
        skippedByRun.set(page.runId, (skippedByRun.get(page.runId) ?? 0) + 1);
      }
      for (const oldRun of supersededRuns) {
        await trx
          .updateTable('knowledgeSpaceCompileRuns')
          .set({
            status: 'superseded',
            skippedPageCount:
              oldRun.skippedPageCount + (skippedByRun.get(oldRun.id) ?? 0),
            errorCode: 'run_superseded',
            errorMessage:
              'A newer knowledge compilation run replaced this run.',
            finishedAt: now,
            updatedAt: now,
          })
          .where('id', '=', oldRun.id)
          .where('status', 'in', NONTERMINAL_RUN_STATUSES)
          .execute();
      }

      const run = await trx
        .insertInto('knowledgeSpaceCompileRuns')
        .values({
          workspaceId: input.workspaceId,
          spaceId: input.spaceId,
          trigger: input.trigger,
          status: input.sources.length === 0 ? 'aggregate_pending' : 'queued',
          expectedPageCount: input.sources.length,
          compilerVersion: input.compilerVersion,
          promptVersion: input.promptVersion,
          catalogSnapshot: input.catalogSnapshot,
          catalogHash: input.catalogHash,
          queuedAt: input.requestedAt ?? now,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      if (input.sources.length > 0) {
        await trx
          .insertInto('knowledgeSpaceCompileRunPages')
          .values(
            input.sources.map((source) => ({
              runId: run.id,
              workspaceId: input.workspaceId,
              spaceId: input.spaceId,
              sourcePageId: source.sourcePageId,
              expectedSourceVersion: source.sourceVersion,
              expectedSourceContentHash: source.sourceContentHash,
              status: 'pending',
              updatedAt: now,
            })),
          )
          .execute();
      }

      const supersededJobIds = [
        ...supersededPages.map((page) => page.jobId),
        ...supersededRuns.map((oldRun) => oldRun.aggregateJobId),
      ].filter((jobId): jobId is string => Boolean(jobId));

      return {
        created: true as const,
        run,
        supersededRunIds,
        supersededJobIds: [...new Set(supersededJobIds)],
      };
    });
  }

  async isRunActive(input: {
    runId: string;
    workspaceId: string;
    spaceId: string;
  }): Promise<boolean> {
    const row = await this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .select('id')
      .where('id', '=', input.runId)
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('status', 'in', NONTERMINAL_RUN_STATUSES)
      .executeTakeFirst();
    return Boolean(row);
  }

  async isRunActiveForPublication(
    input: { runId: string; workspaceId: string; spaceId: string },
    trx: KyselyTransaction,
  ): Promise<boolean> {
    await trx
      .selectFrom('spaces')
      .select('id')
      .where('id', '=', input.spaceId)
      .where('workspaceId', '=', input.workspaceId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const row = await trx
      .selectFrom('knowledgeSpaceCompileRuns')
      .select('id')
      .where('id', '=', input.runId)
      .where('workspaceId', '=', input.workspaceId)
      .where('spaceId', '=', input.spaceId)
      .where('status', 'in', NONTERMINAL_RUN_STATUSES)
      .executeTakeFirst();
    return Boolean(row);
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

  async hasActiveRun(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<boolean> {
    return Boolean(await this.findActiveRun(input));
  }

  async completePage(input: {
    runId: string;
    sourcePageId: string;
    status: Extract<
      KnowledgeSpaceCompileRunPageStatus,
      'succeeded' | 'failed' | 'skipped'
    >;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) {
    return executeTx(this.db, async (trx) => {
      const current = await trx
        .selectFrom('knowledgeSpaceCompileRunPages as rp')
        .innerJoin('knowledgeSpaceCompileRuns as r', 'r.id', 'rp.runId')
        .select([
          'rp.status as pageStatus',
          'r.status as runStatus',
          'r.expectedPageCount',
          'r.succeededPageCount',
          'r.failedPageCount',
          'r.skippedPageCount',
        ])
        .where('rp.runId', '=', input.runId)
        .where('rp.sourcePageId', '=', input.sourcePageId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return undefined;

      const transition = advanceSpaceRunBarrier(
        {
          status: current.runStatus,
          expectedPageCount: current.expectedPageCount,
          succeededPageCount: current.succeededPageCount,
          failedPageCount: current.failedPageCount,
          skippedPageCount: current.skippedPageCount,
        },
        current.pageStatus,
        input.status,
      );
      if (!transition.accepted) return transition;

      const now = new Date();
      await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          status: input.status,
          errorCode: input.errorCode
            ? sanitizeDiagnostic(input.errorCode, 80)
            : null,
          errorMessage: input.errorMessage
            ? sanitizeDiagnostic(input.errorMessage, 500)
            : null,
          finishedAt: now,
          updatedAt: now,
        })
        .where('runId', '=', input.runId)
        .where('sourcePageId', '=', input.sourcePageId)
        .execute();
      await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          status: transition.status,
          succeededPageCount: transition.succeededPageCount,
          failedPageCount: transition.failedPageCount,
          skippedPageCount: transition.skippedPageCount,
          updatedAt: now,
        })
        .where('id', '=', input.runId)
        .execute();

      return transition;
    });
  }

  async findPendingPageDispatches(limit = 100) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRunPages as rp')
      .innerJoin('knowledgeSpaceCompileRuns as r', 'r.id', 'rp.runId')
      .select([
        'rp.runId',
        'rp.workspaceId',
        'rp.spaceId',
        'rp.sourcePageId',
        'rp.expectedSourceVersion',
        'rp.expectedSourceContentHash',
        'r.trigger',
        'r.compilerVersion',
        'r.promptVersion',
      ])
      .where('rp.status', '=', 'pending')
      .where('r.status', 'in', ['queued', 'compiling'])
      .orderBy('rp.createdAt', 'asc')
      .limit(limit)
      .execute();
  }

  async markPageQueued(input: {
    runId: string;
    sourcePageId: string;
    jobId: string;
  }): Promise<boolean> {
    return executeTx(this.db, async (trx) => {
      const now = new Date();

      // Serialize with createRun() supersession. A worker may advance the page
      // before this outbox acknowledgement is persisted, so the parent run is
      // the authoritative acceptance fence rather than the page's old status.
      const run = await trx
        .selectFrom('knowledgeSpaceCompileRuns')
        .select('id')
        .where('id', '=', input.runId)
        .where('status', '!=', 'superseded')
        .forUpdate()
        .executeTakeFirst();
      if (!run) return false;

      await trx
        .updateTable('knowledgeSpaceCompileRunPages')
        .set({
          status: 'queued',
          jobId: input.jobId,
          queuedAt: now,
          updatedAt: now,
        })
        .where('runId', '=', input.runId)
        .where('sourcePageId', '=', input.sourcePageId)
        .where('status', '=', 'pending')
        .execute();
      await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({
          status: 'compiling',
          startedAt: sql`coalesce(started_at, now())`,
          updatedAt: now,
        })
        .where('id', '=', input.runId)
        .where('status', 'in', ['queued', 'compiling'])
        .execute();
      return true;
    });
  }

  async markPageRunning(input: {
    runId: string;
    sourcePageId: string;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .updateTable('knowledgeSpaceCompileRunPages')
      .set({ status: 'running', startedAt: now, updatedAt: now })
      .where('runId', '=', input.runId)
      .where('sourcePageId', '=', input.sourcePageId)
      .where('status', 'in', ['queued', 'running'])
      .execute();
  }

  async findAggregatePendingRuns(limit = 50) {
    return this.db
      .selectFrom('knowledgeSpaceCompileRuns')
      .select(['id', 'workspaceId', 'spaceId'])
      .where('status', '=', 'aggregate_pending')
      .where('aggregateJobId', 'is', null)
      .orderBy('updatedAt', 'asc')
      .limit(limit)
      .execute();
  }

  async markAggregationQueued(input: {
    runId: string;
    jobId: string;
  }): Promise<boolean> {
    const run = await this.db
      .updateTable('knowledgeSpaceCompileRuns')
      .set({ aggregateJobId: input.jobId, updatedAt: new Date() })
      .where('id', '=', input.runId)
      .where('aggregateJobId', 'is', null)
      .where('status', '!=', 'superseded')
      .returning('id')
      .executeTakeFirst();
    return Boolean(run);
  }

  async startAggregation(runId: string) {
    const now = new Date();
    return this.db
      .updateTable('knowledgeSpaceCompileRuns')
      .set({
        status: 'aggregating',
        aggregateStartedAt: now,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where('id', '=', runId)
      .where('status', '=', 'aggregate_pending')
      .returningAll()
      .executeTakeFirst();
  }

  async completeAggregation(input: {
    runId: string;
    importedArtifactCount: number;
    quarantinedArtifactCount: number;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .updateTable('knowledgeSpaceCompileRuns')
      .set({
        status: sql`case when failed_page_count + skipped_page_count > 0 then 'partial' else 'succeeded' end`,
        importedArtifactCount: input.importedArtifactCount,
        quarantinedArtifactCount: input.quarantinedArtifactCount,
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where('id', '=', input.runId)
      .where('status', '=', 'aggregating')
      .execute();
  }

  async failAggregation(input: {
    runId: string;
    errorCode: string;
    errorMessage: string;
    terminal: boolean;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .updateTable('knowledgeSpaceCompileRuns')
      .set({
        status: input.terminal ? 'failed' : 'aggregate_pending',
        aggregateJobId: input.terminal ? undefined : null,
        errorCode: sanitizeDiagnostic(input.errorCode, 80),
        errorMessage: sanitizeDiagnostic(input.errorMessage, 500),
        finishedAt: input.terminal ? now : null,
        updatedAt: now,
      })
      .where('id', '=', input.runId)
      .where('status', '=', 'aggregating')
      .execute();
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

export function advanceSpaceRunBarrier(
  run: BarrierState,
  previousPageStatus: string,
  terminalStatus: Extract<
    KnowledgeSpaceCompileRunPageStatus,
    'succeeded' | 'failed' | 'skipped'
  >,
): {
  accepted: boolean;
  aggregationReady: boolean;
  status: string;
  succeededPageCount: number;
  failedPageCount: number;
  skippedPageCount: number;
} {
  const unchanged = {
    accepted: false,
    aggregationReady: false,
    status: run.status,
    succeededPageCount: run.succeededPageCount,
    failedPageCount: run.failedPageCount,
    skippedPageCount: run.skippedPageCount,
  };
  if (
    isTerminalPageStatus(previousPageStatus) ||
    isTerminalRunStatus(run.status)
  ) {
    return unchanged;
  }

  const next = {
    succeededPageCount:
      run.succeededPageCount + (terminalStatus === 'succeeded' ? 1 : 0),
    failedPageCount:
      run.failedPageCount + (terminalStatus === 'failed' ? 1 : 0),
    skippedPageCount:
      run.skippedPageCount + (terminalStatus === 'skipped' ? 1 : 0),
  };
  const aggregationReady =
    next.succeededPageCount + next.failedPageCount + next.skippedPageCount >=
    run.expectedPageCount;

  return {
    accepted: true,
    aggregationReady,
    status: aggregationReady ? 'aggregate_pending' : 'compiling',
    ...next,
  };
}

function isTerminalPageStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'skipped';
}

function isTerminalRunStatus(status: string): boolean {
  return (
    status === 'aggregate_pending' ||
    status === 'aggregating' ||
    status === 'succeeded' ||
    status === 'partial' ||
    status === 'failed' ||
    status === 'superseded'
  );
}

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
