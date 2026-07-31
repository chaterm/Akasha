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
        queueStubs[2] as never,
        queueStubs[0] as never,
      );
    });

    afterAll(async () => {
      if (!db) return;
      await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
      await db.destroy();
    });

    it('uses fixed database aggregates and paginates Runs and on-demand RunPages', async () => {
      const summary = await service.getRunDiagnosticsSummary({
        workspaceId: 'workspace-1',
        spaceIds: ['space-a'],
        enforceSpaceScope: true,
        canViewGlobalQueues: false,
      });
      expect(summary.activeRunCount).toBe(100);
      expect(summary.waitingInitializationCount).toBe(100);
      expect(summary.phaseCounts).toMatchObject({ text: 100, images: 1 });
      expect(summary.failureCategories.provider).toBe(1);
      expect(summary.queues).toBeUndefined();

      const runs = await service.listRunDiagnostics({
        workspaceId: 'workspace-1',
        spaceIds: ['space-a'],
        enforceSpaceScope: true,
        page: 1,
        limit: 5,
      });
      expect(runs.total).toBe(113);
      expect(runs.items).toHaveLength(5);
      expect(runs.items[0]).toMatchObject({
        runId: 'run-space-a-latest',
        spaceId: 'space-a',
      });

      const detail = await service.listRunPageDiagnostics({
        workspaceId: 'workspace-1',
        runId: 'run-space-a-latest',
        allowedSpaceIds: ['space-a'],
        page: 1,
        limit: 2,
        includeSensitiveErrors: false,
      });
      expect(detail).toMatchObject({ total: 3, page: 1, limit: 2 });
      expect(detail?.items).toHaveLength(2);
      expect(JSON.stringify(detail)).not.toContain('private page content');
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
      initialized_at timestamptz,
      space_job_id varchar,
      space_job_dispatched_at timestamptz,
      space_job_queued_at timestamptz,
      space_job_recovery_count integer not null default 0,
      space_job_sequence integer not null default 0,
      execution_lease_expires_at timestamptz,
      last_yield_at timestamptz,
      last_yield_reason varchar,
      worker_id varchar,
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
      expected_source_version varchar not null default 'v1',
      expected_source_content_hash varchar not null default 'sha256:fixture',
      error_code varchar,
      error_message varchar,
      queued_at timestamptz,
      started_at timestamptz,
      finished_at timestamptz,
      updated_at timestamptz not null
    );
    create table knowledge_space_compile_run_images (
      id varchar primary key,
      run_id varchar not null,
      run_page_id varchar not null,
      status varchar not null,
      job_id varchar,
      dispatched_at timestamptz,
      redis_recovery_count integer not null default 0,
      failure_class varchar,
      error_code varchar
    );
    create table pages (
      id varchar primary key,
      title varchar not null,
      slug_id varchar not null
    );

    insert into spaces (id, workspace_id, name) values
      ('space-a', 'workspace-1', 'Space A'),
      ('space-b', 'workspace-1', 'Space B'),
      ('space-denied', 'workspace-1', 'Denied Space');

    insert into pages (id, title, slug_id) values
      ('page-a-1', 'Page A1', 'page-a-1'),
      ('page-a-2', 'Page A2', 'page-a-2'),
      ('page-a-3', 'Page A3', 'page-a-3'),
      ('page-b-1', 'Page B1', 'page-b-1');

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
      knowledge_generation, expected_page_count, initialized_at,
      space_job_queued_at, space_job_sequence, queued_at, created_at,
      updated_at
    )
    select
      'run-scale-' || run_number,
      'workspace-1',
      'space-a',
      'queued',
      'incremental',
      'text',
      10,
      50,
      null,
      timestamptz '2026-07-27 06:00:00+00' + run_number * interval '1 second',
      1,
      timestamptz '2026-07-27 06:00:00+00' + run_number * interval '1 second',
      timestamptz '2026-07-27 06:00:00+00' + run_number * interval '1 second',
      timestamptz '2026-07-27 06:00:00+00' + run_number * interval '1 second'
    from generate_series(1, 100) as run_number;

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

    insert into knowledge_space_compile_run_images (
      id, run_id, run_page_id, status, failure_class, error_code
    ) values
      ('image-a-1', 'run-space-a-latest', 'run-page-a-2', 'failed',
       'retryable_exhausted', 'image_job_attempts_exhausted'),
      ('image-a-2', 'run-space-a-latest', 'run-page-a-2', 'failed',
       'permanent', 'unsupported_image');
  `.execute(db);
}

function logEvidence(evidence: unknown): void {
  if (process.env.AKASHA_MIGRATION_TEST_EVIDENCE !== '1') return;
  console.info(
    'knowledge_diagnostics_database_evidence',
    JSON.stringify(evidence),
  );
}
