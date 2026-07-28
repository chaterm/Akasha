import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeDiagnosticsService } from './knowledge-diagnostics.service';

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres(
  'KnowledgeDiagnosticsService PostgreSQL durable progress',
  () => {
    const schema = `akasha_diagnostics_${randomUUID().replaceAll('-', '')}`;
    let client: ReturnType<typeof postgres>;
    let db: Kysely<unknown>;
    let service: KnowledgeDiagnosticsService;
    const queueStubs = Array.from({ length: 3 }, () => ({
      getJobs: jest.fn(),
      getJobCounts: jest.fn(),
    }));
    const quality = { evaluate: jest.fn().mockReturnValue({}) };
    const queryAuditRepo = { summarizeWorkspace: jest.fn() };
    const quarantineRepo = { findRecentByWorkspace: jest.fn() };

    beforeAll(async () => {
      client = postgres(normalizePostgresUrl(integrationDatabaseUrl!), {
        max: 1,
        onnotice: () => {},
      });
      db = new Kysely({
        dialect: new PostgresJSDialect({ postgres: client }),
        plugins: [new CamelCasePlugin()],
      });
      await sql.raw(`create schema "${schema}"`).execute(db);
      await sql.raw(`set search_path to "${schema}"`).execute(db);
      await createFixture(db);
      service = new KnowledgeDiagnosticsService(
        db as never,
        queueStubs[1] as never,
        queueStubs[2] as never,
        quality as never,
        queryAuditRepo as never,
        quarantineRepo as never,
        {} as never,
      );
    });

    afterAll(async () => {
      if (!db) return;
      await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
      await db.destroy();
    });

    it('returns each authorized Space latest Run and aggregates durable RunPage progress without BullMQ jobs', async () => {
      const rawRunError = await sql<{ errorMessage: string }>`
      select error_message as "errorMessage"
      from knowledge_space_compile_runs
      where id = 'run-space-a-latest'
    `.execute(db);
      const rawPageError = await sql<{ errorMessage: string }>`
      select error_message as "errorMessage"
      from knowledge_space_compile_run_pages
      where run_id = 'run-space-a-latest' and source_page_id = 'page-a-3'
    `.execute(db);
      expect(rawRunError.rows[0].errorMessage).toBe(
        'raw provider response from durable Run',
      );
      expect(rawPageError.rows[0].errorMessage).toBe(
        'raw provider response and private page content',
      );

      const diagnostics = await service.getWorkspaceDiagnostics({
        workspaceId: 'workspace-1',
        spaceIds: ['space-a', 'space-b'],
        enforceSpaceScope: true,
        canViewGlobalQueues: false,
        includeDetailedDiagnostics: false,
        limit: 2,
      });

      expect(diagnostics.jobs).toEqual([]);
      expect(diagnostics.queueCounts).toEqual({
        waiting: 0,
        active: 0,
        delayed: 0,
        prioritized: 0,
        waitingChildren: 0,
        paused: 0,
        failed: 0,
        completed: 0,
      });
      for (const queue of queueStubs) {
        expect(queue.getJobs).not.toHaveBeenCalled();
        expect(queue.getJobCounts).not.toHaveBeenCalled();
      }

      expect(diagnostics.compileRuns.map((run) => run.runId)).toEqual([
        'run-space-b-latest',
        'run-space-a-latest',
      ]);
      expect(
        diagnostics.compileStatuses.map((status) => status.lastRunId),
      ).toEqual(['run-space-b-latest', 'run-space-a-latest']);
      expect(diagnostics.compileStatuses).toContainEqual(
        expect.objectContaining({
          spaceId: 'space-a',
          status: 'failed',
          failureReason: 'Knowledge compiler provider request failed.',
        }),
      );
      expect(diagnostics.compileRuns[1]).toEqual({
        runId: 'run-space-a-latest',
        spaceId: 'space-a',
        spaceName: 'Space A',
        status: 'failed',
        mode: 'update',
        phase: 'images',
        generation: 4,
        createdAt: '2026-07-28T07:00:00.000Z',
        updatedAt: '2026-07-28T07:02:00.000Z',
        completedAt: '2026-07-28T07:02:00.000Z',
        progress: {
          text: {
            expected: 3,
            succeeded: 1,
            failed: 1,
            skipped: 1,
            pending: 0,
            waiting: 0,
            lastAttemptError: 'Knowledge compiler provider request failed.',
          },
          image: {
            expected: 5,
            succeeded: 3,
            failed: 1,
            skipped: 1,
            pending: 0,
            waiting: 0,
            lastAttemptError: 'Image processing completed with failures.',
          },
          merge: {
            expected: 2,
            succeeded: 1,
            failed: 0,
            skipped: 0,
            pending: 1,
            waiting: 1,
          },
        },
      });
      expect(JSON.stringify(diagnostics)).not.toContain(
        'raw provider response',
      );
      expect(JSON.stringify(diagnostics)).not.toContain('private page content');
      logEvidence({
        selectedRunIds: diagnostics.compileRuns.map((run) => run.runId),
        durableProgress: diagnostics.compileRuns[1].progress,
        bullJobs: diagnostics.jobs.length,
        rawErrorsExposed: false,
      });
    });
  },
);

async function createFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table spaces (
      id varchar primary key,
      workspace_id varchar not null,
      name varchar not null,
      deleted_at timestamptz
    );
    create table knowledge_space_compile_runs (
      id varchar primary key,
      workspace_id varchar not null,
      space_id varchar not null,
      status varchar not null,
      mode varchar not null,
      phase varchar not null,
      knowledge_generation integer not null default 0,
      expected_page_count integer not null default 0,
      succeeded_page_count integer not null default 0,
      failed_page_count integer not null default 0,
      skipped_page_count integer not null default 0,
      imported_artifact_count integer not null default 0,
      quarantined_artifact_count integer not null default 0,
      aggregate_job_id varchar,
      error_code varchar,
      error_message varchar,
      queued_at timestamptz not null,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create table knowledge_space_compile_run_pages (
      id varchar primary key,
      run_id varchar not null,
      workspace_id varchar not null,
      space_id varchar not null,
      source_page_id varchar not null,
      status varchar not null,
      expected_image_count integer not null default 0,
      succeeded_image_count integer not null default 0,
      failed_image_count integer not null default 0,
      skipped_image_count integer not null default 0,
      image_status varchar not null default 'not_required',
      merge_status varchar not null default 'not_required',
      error_code varchar,
      error_message varchar,
      updated_at timestamptz not null
    );

    insert into spaces (id, workspace_id, name) values
      ('space-a', 'workspace-1', 'Space A'),
      ('space-b', 'workspace-1', 'Space B'),
      ('space-denied', 'workspace-1', 'Denied Space');

    insert into knowledge_space_compile_runs (
      id, workspace_id, space_id, status, mode, phase,
      knowledge_generation, expected_page_count, queued_at, created_at,
      updated_at
    )
    select
      'run-space-a-old-' || old_run,
      'workspace-1',
      'space-a',
      'succeeded',
      'incremental',
      'complete',
      3,
      1,
      timestamptz '2026-07-28 06:00:00+00' - old_run * interval '1 minute',
      timestamptz '2026-07-28 06:00:00+00' - old_run * interval '1 minute',
      timestamptz '2026-07-28 06:00:00+00' - old_run * interval '1 minute'
    from generate_series(1, 12) as old_run;

    insert into knowledge_space_compile_runs (
      id, workspace_id, space_id, status, mode, phase,
      knowledge_generation, expected_page_count, succeeded_page_count,
      failed_page_count, skipped_page_count, error_code, error_message,
      queued_at, started_at, finished_at, created_at, updated_at
    ) values (
      'run-space-a-latest', 'workspace-1', 'space-a', 'failed',
      'incremental', 'images', 4, 3, 1, 1, 1, 'provider_error',
      'raw provider response from durable Run',
      '2026-07-28 07:00:00+00', '2026-07-28 07:00:30+00',
      '2026-07-28 07:02:00+00', '2026-07-28 07:00:00+00',
      '2026-07-28 07:02:00+00'
    ), (
      'run-space-b-latest', 'workspace-1', 'space-b', 'succeeded',
      'force_rebuild', 'complete', 8, 1, 1, 0, 0, null, null,
      '2026-07-28 08:00:00+00', '2026-07-28 08:00:30+00',
      '2026-07-28 08:01:00+00', '2026-07-28 08:00:00+00',
      '2026-07-28 08:01:00+00'
    ), (
      'run-space-denied-latest', 'workspace-1', 'space-denied', 'succeeded',
      'incremental', 'complete', 2, 1, 1, 0, 0, null, null,
      '2026-07-28 09:00:00+00', '2026-07-28 09:00:30+00',
      '2026-07-28 09:01:00+00', '2026-07-28 09:00:00+00',
      '2026-07-28 09:01:00+00'
    );

    insert into knowledge_space_compile_run_pages (
      id, run_id, workspace_id, space_id, source_page_id, status,
      expected_image_count, succeeded_image_count, failed_image_count,
      skipped_image_count, image_status, merge_status, error_code,
      error_message, updated_at
    ) values
      ('run-page-a-1', 'run-space-a-latest', 'workspace-1', 'space-a',
       'page-a-1', 'succeeded', 2, 2, 0, 0, 'succeeded', 'succeeded',
       null, null, '2026-07-28 07:01:00+00'),
      ('run-page-a-2', 'run-space-a-latest', 'workspace-1', 'space-a',
       'page-a-2', 'skipped', 3, 1, 1, 1, 'partial', 'pending',
       null, null, '2026-07-28 07:01:30+00'),
      ('run-page-a-3', 'run-space-a-latest', 'workspace-1', 'space-a',
       'page-a-3', 'failed', 0, 0, 0, 0, 'not_required', 'not_required',
       'provider_error', 'raw provider response and private page content',
       '2026-07-28 07:02:00+00'),
      ('run-page-b-1', 'run-space-b-latest', 'workspace-1', 'space-b',
       'page-b-1', 'succeeded', 1, 1, 0, 0, 'succeeded', 'succeeded',
       null, null, '2026-07-28 08:01:00+00');
  `.execute(db);
}

function logEvidence(evidence: unknown): void {
  if (process.env.AKASHA_MIGRATION_TEST_EVIDENCE !== '1') return;
  console.info(
    'knowledge_diagnostics_database_evidence',
    JSON.stringify(evidence),
  );
}
