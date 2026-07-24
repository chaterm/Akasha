import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { JsonValue } from '@akasha/db/types/db';
import { KyselyDB } from '@akasha/db/types/kysely.types';
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
    sources: Array<{
      sourcePageId: string;
      sourceVersion: string;
      sourceContentHash: string;
    }>;
  }) {
    return executeTx(this.db, async (trx) => {
      const now = new Date();
      await trx
        .updateTable('knowledgeSpaceCompileRuns')
        .set({ status: 'superseded', finishedAt: now, updatedAt: now })
        .where('workspaceId', '=', input.workspaceId)
        .where('spaceId', '=', input.spaceId)
        .where('status', 'in', NONTERMINAL_RUN_STATUSES)
        .execute();

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
          queuedAt: now,
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

      return run;
    });
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
  }): Promise<void> {
    await executeTx(this.db, async (trx) => {
      const now = new Date();
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
  }): Promise<void> {
    await this.db
      .updateTable('knowledgeSpaceCompileRuns')
      .set({ aggregateJobId: input.jobId, updatedAt: new Date() })
      .where('id', '=', input.runId)
      .where('aggregateJobId', 'is', null)
      .where('status', '!=', 'superseded')
      .execute();
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
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
