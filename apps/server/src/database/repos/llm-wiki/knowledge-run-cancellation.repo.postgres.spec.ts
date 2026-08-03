import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeSpaceCompilationRepo } from './knowledge-space-compilation.repo';

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('Knowledge Run cancellation PostgreSQL round trip', () => {
  const schema = `akasha_cancel_run_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: KnowledgeSpaceCompilationRepo;

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
    repo = new KnowledgeSpaceCompilationRepo(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('atomically fences the Run, terminalizes children, and returns exact jobs', async () => {
    const result = await repo.cancelRun({
      workspaceId: 'workspace-1',
      runId: 'run-active',
      reason: 'Capacity test completed.',
    });

    expect(result).toEqual(
      expect.objectContaining({
        disposition: 'cancelled',
        previousStatus: 'compiling',
        previousPhase: 'images',
        jobIds: expect.arrayContaining([
          'space-job',
          'aggregate-job',
          'legacy-text-job',
          'legacy-image-job',
          'legacy-merge-job',
          'image-succeeded-job',
          'image-failed-job',
          'image-processing-job',
        ]),
      }),
    );
    const state = await readState(db);
    expect(state.run).toEqual({
      status: 'cancelled',
      phase: 'complete',
      succeeded: 1,
      failed: 0,
      skipped: 2,
      executionToken: null,
      workerId: null,
      rerunRequested: false,
      errorCode: 'manual_cancelled',
    });
    expect(state.page).toEqual({
      status: 'skipped',
      imageStatus: 'partial',
      mergeStatus: 'skipped',
      succeededImages: 1,
      failedImages: 1,
      skippedImages: 2,
      errorCode: 'manual_cancelled',
    });
    expect(state.processingImage).toEqual({
      status: 'skipped',
      failureClass: null,
      errorCode: 'manual_cancelled',
      processingExpiresAt: null,
    });
    expect(state.unplannedPage).toEqual({
      status: 'skipped',
      imageStatus: 'partial',
      mergeStatus: 'skipped',
      succeededImages: 0,
      failedImages: 0,
      skippedImages: 2,
      errorCode: 'manual_cancelled',
    });

    // An image Worker that held the old exact identity cannot publish after
    // cancellation because the parent Run is no longer compiling/images.
    await expect(
      repo.completeRunImage({
        runImageId: 'image-processing',
        runId: 'run-active',
        knowledgeGeneration: 3,
        jobId: 'image-processing-job',
        status: 'succeeded',
      }),
    ).resolves.toBeUndefined();
  });

  it('is idempotent and workspace scoped', async () => {
    await expect(
      repo.cancelRun({ workspaceId: 'workspace-1', runId: 'run-active' }),
    ).resolves.toEqual(
      expect.objectContaining({ disposition: 'already_terminal' }),
    );
    await expect(
      repo.cancelRun({ workspaceId: 'workspace-other', runId: 'run-active' }),
    ).resolves.toEqual({ disposition: 'not_found' });
  });
});

async function createFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE spaces (
      id varchar PRIMARY KEY,
      workspace_id varchar NOT NULL,
      knowledge_generation integer NOT NULL,
      deleted_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE knowledge_space_compile_runs (
      id varchar PRIMARY KEY,
      workspace_id varchar NOT NULL,
      space_id varchar NOT NULL,
      trigger varchar NOT NULL,
      mode varchar NOT NULL,
      knowledge_generation integer NOT NULL,
      phase varchar NOT NULL,
      status varchar NOT NULL,
      expected_page_count integer NOT NULL,
      succeeded_page_count integer NOT NULL DEFAULT 0,
      failed_page_count integer NOT NULL DEFAULT 0,
      skipped_page_count integer NOT NULL DEFAULT 0,
      compiler_version varchar NOT NULL,
      prompt_version varchar NOT NULL,
      catalog_snapshot jsonb NOT NULL,
      catalog_hash varchar NOT NULL,
      aggregate_required boolean NOT NULL DEFAULT true,
      aggregate_job_id varchar,
      aggregate_started_at timestamptz,
      imported_artifact_count integer NOT NULL DEFAULT 0,
      quarantined_artifact_count integer NOT NULL DEFAULT 0,
      error_code varchar,
      error_message varchar,
      queued_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      initialized_at timestamptz,
      space_job_id varchar,
      space_job_dispatched_at timestamptz,
      space_job_sequence integer NOT NULL DEFAULT 0,
      space_job_queued_at timestamptz,
      space_job_recovery_count integer NOT NULL DEFAULT 0,
      execution_token varchar,
      execution_lease_expires_at timestamptz,
      worker_id varchar,
      heartbeat_at timestamptz,
      last_yield_at timestamptz,
      last_yield_reason varchar,
      rerun_requested boolean NOT NULL DEFAULT false,
      target_source_page_ids jsonb
    );
    CREATE TABLE knowledge_space_compile_run_pages (
      id varchar PRIMARY KEY,
      run_id varchar NOT NULL,
      workspace_id varchar NOT NULL,
      space_id varchar NOT NULL,
      source_page_id varchar NOT NULL,
      expected_source_version varchar NOT NULL,
      expected_source_content_hash varchar NOT NULL,
      expected_image_count integer NOT NULL DEFAULT 0,
      succeeded_image_count integer NOT NULL DEFAULT 0,
      failed_image_count integer NOT NULL DEFAULT 0,
      skipped_image_count integer NOT NULL DEFAULT 0,
      image_status varchar NOT NULL,
      image_job_id varchar,
      merge_status varchar NOT NULL,
      merge_job_id varchar,
      target_effective_knowledge_hash varchar,
      merged_effective_knowledge_hash varchar,
      status varchar NOT NULL,
      job_id varchar,
      error_code varchar,
      error_message varchar,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE knowledge_space_compile_run_images (
      id varchar PRIMARY KEY,
      run_id varchar NOT NULL,
      run_page_id varchar NOT NULL,
      workspace_id varchar NOT NULL,
      space_id varchar NOT NULL,
      source_page_id varchar NOT NULL,
      status varchar NOT NULL,
      failure_class varchar,
      job_id varchar,
      processing_expires_at timestamptz,
      error_code varchar,
      error_message varchar,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO spaces VALUES (
      'space-1', 'workspace-1', 3, NULL, now()
    );
    INSERT INTO knowledge_space_compile_runs (
      id, workspace_id, space_id, trigger, mode, knowledge_generation, phase,
      status, expected_page_count, compiler_version, prompt_version,
      catalog_snapshot, catalog_hash, aggregate_job_id, queued_at,
      initialized_at, space_job_id, space_job_dispatched_at,
      space_job_sequence, execution_token, execution_lease_expires_at,
      worker_id, heartbeat_at, rerun_requested
    ) VALUES (
      'run-active', 'workspace-1', 'space-1', 'manual_compile', 'incremental',
      3, 'images', 'compiling', 3, 'compiler-v1', 'prompt-v1', '[]',
      'sha256:catalog', 'aggregate-job', now(), now(), 'space-job', now(), 9,
      'old-token', now() + interval '3 minutes', 'worker-old', now(), true
    );
    INSERT INTO knowledge_space_compile_run_pages (
      id, run_id, workspace_id, space_id, source_page_id,
      expected_source_version, expected_source_content_hash,
      expected_image_count, image_status, image_job_id, merge_status,
      merge_job_id, status, job_id
    ) VALUES
      (
        'page-complete', 'run-active', 'workspace-1', 'space-1', 'source-1',
        'v1', 'sha256:1', 0, 'not_required', NULL, 'not_required', NULL,
        'succeeded', NULL
      ),
      (
        'page-active', 'run-active', 'workspace-1', 'space-1', 'source-2',
        'v2', 'sha256:2', 4, 'processing', 'legacy-image-job',
        'waiting_images', 'legacy-merge-job', 'running', 'legacy-text-job'
      ),
      (
        'page-unplanned', 'run-active', 'workspace-1', 'space-1', 'source-3',
        'v3', 'sha256:3', 2, 'pending', NULL, 'waiting_images', NULL,
        'pending', NULL
      );
    INSERT INTO knowledge_space_compile_run_images (
      id, run_id, run_page_id, workspace_id, space_id, source_page_id,
      status, failure_class, job_id, processing_expires_at
    ) VALUES
      (
        'image-succeeded', 'run-active', 'page-active', 'workspace-1',
        'space-1', 'source-2', 'succeeded', NULL, 'image-succeeded-job', NULL
      ),
      (
        'image-failed', 'run-active', 'page-active', 'workspace-1',
        'space-1', 'source-2', 'failed', 'permanent', 'image-failed-job', NULL
      ),
      (
        'image-processing', 'run-active', 'page-active', 'workspace-1',
        'space-1', 'source-2', 'processing', NULL, 'image-processing-job',
        now() + interval '3 minutes'
      )
  `.execute(db);
}

async function readState(db: Kysely<unknown>) {
  const run = await sql<{
    status: string;
    phase: string;
    succeeded: number;
    failed: number;
    skipped: number;
    executionToken: string | null;
    workerId: string | null;
    rerunRequested: boolean;
    errorCode: string | null;
  }>`
    SELECT status, phase,
      succeeded_page_count AS succeeded,
      failed_page_count AS failed,
      skipped_page_count AS skipped,
      execution_token AS "executionToken",
      worker_id AS "workerId",
      rerun_requested AS "rerunRequested",
      error_code AS "errorCode"
    FROM knowledge_space_compile_runs WHERE id = 'run-active'
  `.execute(db);
  const page = await sql<{
    status: string;
    imageStatus: string;
    mergeStatus: string;
    succeededImages: number;
    failedImages: number;
    skippedImages: number;
    errorCode: string | null;
  }>`
    SELECT status,
      image_status AS "imageStatus",
      merge_status AS "mergeStatus",
      succeeded_image_count AS "succeededImages",
      failed_image_count AS "failedImages",
      skipped_image_count AS "skippedImages",
      error_code AS "errorCode"
    FROM knowledge_space_compile_run_pages WHERE id = 'page-active'
  `.execute(db);
  const processingImage = await sql<{
    status: string;
    failureClass: string | null;
    errorCode: string | null;
    processingExpiresAt: Date | null;
  }>`
    SELECT status,
      failure_class AS "failureClass",
      error_code AS "errorCode",
      processing_expires_at AS "processingExpiresAt"
    FROM knowledge_space_compile_run_images WHERE id = 'image-processing'
  `.execute(db);
  const unplannedPage = await sql<{
    status: string;
    imageStatus: string;
    mergeStatus: string;
    succeededImages: number;
    failedImages: number;
    skippedImages: number;
    errorCode: string | null;
  }>`
    SELECT status,
      image_status AS "imageStatus",
      merge_status AS "mergeStatus",
      succeeded_image_count AS "succeededImages",
      failed_image_count AS "failedImages",
      skipped_image_count AS "skippedImages",
      error_code AS "errorCode"
    FROM knowledge_space_compile_run_pages WHERE id = 'page-unplanned'
  `.execute(db);
  return {
    run: run.rows[0],
    page: page.rows[0],
    processingImage: processingImage.rows[0],
    unplannedPage: unplannedPage.rows[0],
  };
}
