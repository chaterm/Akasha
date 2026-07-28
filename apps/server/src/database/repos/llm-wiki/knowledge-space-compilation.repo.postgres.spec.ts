import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeSpaceCompilationRepo } from './knowledge-space-compilation.repo';

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('KnowledgeSpaceCompilationRepo PostgreSQL round trip', () => {
  const schema = `akasha_incremental_run_${process.pid}_${Date.now()}`;
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

  it('durably records 2,000 reused pages and completes without queued work', async () => {
    const result = await repo.createRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-reused',
      trigger: 'manual_compile',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
      catalogSnapshot: [],
      catalogHash: 'sha256:aggregate-current',
      aggregateRequired: false,
      sources: Array.from({ length: 2_000 }, (_, index) => ({
        sourcePageId: `page-${index}`,
        sourceVersion: 'v1',
        sourceContentHash: `sha256:${index}`,
        status: 'skipped' as const,
        errorCode: 'unchanged',
        errorMessage: 'Existing compiled knowledge is current.',
      })),
    });

    const evidence = await readRunEvidence(db, result.run.id);
    expect(evidence).toEqual({
      status: 'succeeded',
      phase: 'complete',
      expected: 2_000,
      succeeded: 0,
      failed: 0,
      skipped: 2_000,
      pageRows: 2_000,
      pendingRows: 0,
      unchangedRows: 2_000,
    });
    logEvidence('fully_reused', evidence);
  });

  it('durably records a 999 reused + 1 changed plan before dispatch', async () => {
    const result = await repo.createRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-mixed',
      trigger: 'manual_compile',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
      catalogSnapshot: [],
      catalogHash: 'sha256:aggregate-before',
      aggregateRequired: true,
      sources: [
        ...Array.from({ length: 999 }, (_, index) => ({
          sourcePageId: `reused-${index}`,
          sourceVersion: 'v1',
          sourceContentHash: `sha256:reused-${index}`,
          status: 'skipped' as const,
          errorCode: 'unchanged',
          errorMessage: 'Existing compiled knowledge is current.',
        })),
        {
          sourcePageId: 'changed',
          sourceVersion: 'v2',
          sourceContentHash: 'sha256:changed',
          status: 'pending' as const,
        },
      ],
    });

    const evidence = await readRunEvidence(db, result.run.id);
    expect(evidence).toEqual({
      status: 'queued',
      phase: 'text',
      expected: 1_000,
      succeeded: 0,
      failed: 0,
      skipped: 999,
      pageRows: 1_000,
      pendingRows: 1,
      unchangedRows: 999,
    });
    logEvidence('mixed_incremental', evidence);

    await sql`
      update knowledge_space_compile_run_pages
      set status = 'skipped', error_code = 'empty_source', finished_at = now()
      where run_id = ${result.run.id} and source_page_id = 'changed'
    `.execute(db);
    await sql`
      update knowledge_space_compile_runs
      set status = 'aggregating', phase = 'initial_aggregate',
          skipped_page_count = 1000
      where id = ${result.run.id}
    `.execute(db);
    await repo.completeAggregation({
      runId: result.run.id,
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
      catalogHash: 'sha256:aggregate-after',
      phase: 'initial_aggregate',
    });

    const finalPending = await sql<{ status: string; phase: string }>`
      select status, phase
      from knowledge_space_compile_runs
      where id = ${result.run.id}
    `.execute(db);
    expect(finalPending.rows).toEqual([
      { status: 'aggregate_pending', phase: 'final_aggregate' },
    ]);
    await repo.startAggregation(result.run.id, 'final_aggregate');
    await repo.completeAggregation({
      runId: result.run.id,
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
      catalogHash: 'sha256:aggregate-final',
      phase: 'final_aggregate',
    });

    const completed = await sql<{
      status: string;
      phase: string;
      catalogHash: string;
    }>`
      select status, phase, catalog_hash as "catalogHash"
      from knowledge_space_compile_runs
      where id = ${result.run.id}
    `.execute(db);
    expect(completed.rows).toEqual([
      {
        status: 'succeeded',
        phase: 'complete',
        catalogHash: 'sha256:aggregate-final',
      },
    ]);
    logEvidence('neutral_skips_completed', completed.rows[0]);

    await sql`
      update knowledge_space_compile_runs
      set status = 'aggregating', phase = 'final_aggregate'
      where id = ${result.run.id}
    `.execute(db);
    await sql`
      update knowledge_space_compile_run_pages
      set image_status = 'partial'
      where run_id = ${result.run.id} and source_page_id = 'changed'
    `.execute(db);
    await repo.completeAggregation({
      runId: result.run.id,
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
      catalogHash: 'sha256:aggregate-image-partial',
      phase: 'final_aggregate',
    });
    const degraded = await sql<{ status: string; phase: string }>`
      select status, phase
      from knowledge_space_compile_runs
      where id = ${result.run.id}
    `.execute(db);
    expect(degraded.rows).toEqual([{ status: 'partial', phase: 'complete' }]);
    logEvidence('true_image_failure_partial', degraded.rows[0]);
  });

  it('durably advances initial aggregate to a fenced page image terminal state', async () => {
    const result = await repo.createRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-images',
      trigger: 'manual_compile',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
      catalogSnapshot: [],
      catalogHash: 'sha256:before-images',
      aggregateRequired: true,
      sources: [
        {
          sourcePageId: 'image-page',
          sourceVersion: 'v1',
          sourceContentHash: 'sha256:image-page',
          expectedImageCount: 13,
          imageStatus: 'pending',
          mergeStatus: 'waiting_images',
        },
      ],
    });
    await sql`
      update knowledge_space_compile_run_pages
      set status = 'succeeded', finished_at = now()
      where run_id = ${result.run.id}
    `.execute(db);
    await sql`
      update knowledge_space_compile_runs
      set status = 'aggregating', phase = 'initial_aggregate',
          succeeded_page_count = 1
      where id = ${result.run.id}
    `.execute(db);
    await repo.completeAggregation({
      runId: result.run.id,
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
      catalogHash: 'sha256:initial-aggregate',
      phase: 'initial_aggregate',
    });

    const pending = await repo.findPendingImageDispatches();
    expect(pending).toHaveLength(1);
    expect(
      await repo.markPageImageQueued({
        runId: result.run.id,
        sourcePageId: 'image-page',
        sourceVersion: 'v1',
        sourceContentHash: 'sha256:image-page',
        knowledgeGeneration: 0,
        jobId: 'image-job-1',
      }),
    ).toBe(true);
    expect(
      await repo.beginPageImages({
        runId: result.run.id,
        sourcePageId: 'image-page',
        sourceVersion: 'v1',
        sourceContentHash: 'sha256:image-page',
        knowledgeGeneration: 0,
      }),
    ).toBe(true);
    expect(
      await repo.completePageImages({
        runId: result.run.id,
        sourcePageId: 'image-page',
        sourceVersion: 'v1',
        sourceContentHash: 'sha256:image-page',
        knowledgeGeneration: 0,
        status: 'partial',
        expected: 13,
        succeeded: 12,
        failed: 0,
        skipped: 1,
      }),
    ).toBe(true);

    const evidence = await sql<{
      runStatus: string;
      phase: string;
      imageStatus: string;
      expected: number;
      succeeded: number;
      failed: number;
      skipped: number;
      mergeStatus: string;
    }>`
      select
        run.status as "runStatus",
        run.phase,
        page.image_status as "imageStatus",
        page.expected_image_count as expected,
        page.succeeded_image_count as succeeded,
        page.failed_image_count as failed,
        page.skipped_image_count as skipped,
        page.merge_status as "mergeStatus"
      from knowledge_space_compile_runs run
      join knowledge_space_compile_run_pages page on page.run_id = run.id
      where run.id = ${result.run.id}
    `.execute(db);
    expect(evidence.rows).toEqual([
      {
        runStatus: 'compiling',
        phase: 'images',
        imageStatus: 'partial',
        expected: 13,
        succeeded: 12,
        failed: 0,
        skipped: 1,
        mergeStatus: 'pending',
      },
    ]);
    logEvidence('page_image_terminal', evidence.rows[0]);

    const pendingMerge = await repo.findPendingMergeDispatches();
    expect(pendingMerge).toHaveLength(1);
    expect(
      await repo.markPageMergeQueued({
        runId: result.run.id,
        sourcePageId: 'image-page',
        sourceVersion: 'v1',
        sourceContentHash: 'sha256:image-page',
        knowledgeGeneration: 0,
        effectiveKnowledgeHash: 'sha256:image-merged',
        jobId: 'merge-job-1',
      }),
    ).toBe(true);
    expect(
      await repo.beginPageMerge({
        runId: result.run.id,
        sourcePageId: 'image-page',
        sourceVersion: 'v1',
        sourceContentHash: 'sha256:image-page',
        knowledgeGeneration: 0,
        effectiveKnowledgeHash: 'sha256:image-merged',
      }),
    ).toBe(true);
    await db.transaction().execute(async (trx) => {
      expect(
        await repo.completePageMergePublication(
          {
            runId: result.run.id,
            sourcePageId: 'image-page',
            sourceVersion: 'v1',
            sourceContentHash: 'sha256:image-page',
            knowledgeGeneration: 0,
            mergedEffectiveKnowledgeHash: 'sha256:image-merged',
          },
          trx as never,
        ),
      ).toBe(true);
    });
    const merged = await sql<{
      status: string;
      phase: string;
      mergeStatus: string;
      mergedHash: string;
      aggregateJobId: string | null;
    }>`
      select run.status, run.phase,
        page.merge_status as "mergeStatus",
        page.merged_effective_knowledge_hash as "mergedHash",
        run.aggregate_job_id as "aggregateJobId"
      from knowledge_space_compile_runs run
      join knowledge_space_compile_run_pages page on page.run_id = run.id
      where run.id = ${result.run.id}
    `.execute(db);
    expect(merged.rows).toEqual([
      {
        status: 'aggregate_pending',
        phase: 'final_aggregate',
        mergeStatus: 'succeeded',
        mergedHash: 'sha256:image-merged',
        aggregateJobId: null,
      },
    ]);
    logEvidence('page_merge_publication', merged.rows[0]);

    await repo.startAggregation(result.run.id, 'final_aggregate');
    await repo.completeAggregation({
      runId: result.run.id,
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
      catalogHash: 'sha256:final-aggregate',
      phase: 'final_aggregate',
    });
    const finished = await sql<{ status: string; phase: string }>`
      select status, phase
      from knowledge_space_compile_runs
      where id = ${result.run.id}
    `.execute(db);
    expect(finished.rows).toEqual([{ status: 'partial', phase: 'complete' }]);
    logEvidence('final_aggregate_partial', finished.rows[0]);
  });

  it('lets an image worker claim a pending outbox row before the queue acknowledgement', async () => {
    const result = await createPendingImageRun(repo, db, 'race-worker-first');

    expect(
      await repo.beginPageImages({
        runId: result.run.id,
        sourcePageId: 'race-worker-first',
        sourceVersion: 'v1',
        sourceContentHash: 'sha256:race-worker-first',
        knowledgeGeneration: 0,
      }),
    ).toBe(true);

    const page = await readImageDispatchState(db, result.run.id);
    expect(page).toEqual({ imageStatus: 'processing', imageJobId: null });
  });

  it('acknowledges a worker-first image job without regressing processing to queued', async () => {
    const result = await createPendingImageRun(repo, db, 'race-queue-ack');
    await sql`
      update knowledge_space_compile_run_pages
      set image_status = 'processing'
      where run_id = ${result.run.id}
    `.execute(db);

    expect(
      await repo.markPageImageQueued({
        runId: result.run.id,
        sourcePageId: 'race-queue-ack',
        sourceVersion: 'v1',
        sourceContentHash: 'sha256:race-queue-ack',
        knowledgeGeneration: 0,
        jobId: 'image-job-worker-first',
      }),
    ).toBe(true);

    const page = await readImageDispatchState(db, result.run.id);
    expect(page).toEqual({
      imageStatus: 'processing',
      imageJobId: 'image-job-worker-first',
    });
  });

  it('skips merge and opens final aggregate when no image produced searchable content', async () => {
    const result = await repo.createRun({
      workspaceId: 'workspace-1',
      spaceId: 'space-no-image-content',
      trigger: 'manual_compile',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
      catalogSnapshot: [],
      catalogHash: 'sha256:before-images',
      aggregateRequired: true,
      sources: [
        {
          sourcePageId: 'failed-image-page',
          sourceVersion: 'v1',
          sourceContentHash: 'sha256:failed-image-page',
          expectedImageCount: 1,
          imageStatus: 'pending',
          mergeStatus: 'waiting_images',
        },
      ],
    });
    await sql`
      update knowledge_space_compile_run_pages
      set status = 'succeeded', finished_at = now()
      where run_id = ${result.run.id}
    `.execute(db);
    await sql`
      update knowledge_space_compile_runs
      set status = 'aggregating', phase = 'initial_aggregate',
          succeeded_page_count = 1
      where id = ${result.run.id}
    `.execute(db);
    await repo.completeAggregation({
      runId: result.run.id,
      importedArtifactCount: 1,
      quarantinedArtifactCount: 0,
      catalogHash: 'sha256:initial',
      phase: 'initial_aggregate',
    });
    await repo.markPageImageQueued({
      runId: result.run.id,
      sourcePageId: 'failed-image-page',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:failed-image-page',
      knowledgeGeneration: 0,
      jobId: 'failed-image-job',
    });
    await repo.beginPageImages({
      runId: result.run.id,
      sourcePageId: 'failed-image-page',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:failed-image-page',
      knowledgeGeneration: 0,
    });
    await repo.completePageImages({
      runId: result.run.id,
      sourcePageId: 'failed-image-page',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:failed-image-page',
      knowledgeGeneration: 0,
      status: 'failed',
      expected: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });

    const evidence = await sql<{
      status: string;
      phase: string;
      mergeStatus: string;
    }>`
      select run.status, run.phase, page.merge_status as "mergeStatus"
      from knowledge_space_compile_runs run
      join knowledge_space_compile_run_pages page on page.run_id = run.id
      where run.id = ${result.run.id}
    `.execute(db);
    expect(evidence.rows).toEqual([
      {
        status: 'aggregate_pending',
        phase: 'final_aggregate',
        mergeStatus: 'skipped',
      },
    ]);
    logEvidence('no_image_content_final_barrier', evidence.rows[0]);
  });
});

async function createFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create sequence run_id_seq;
    create sequence run_page_id_seq;
    create table spaces (
      id varchar primary key,
      workspace_id varchar not null,
      name varchar not null,
      knowledge_generation integer not null default 0
    );
    create table knowledge_space_compile_runs (
      id varchar primary key default ('run-' || nextval('run_id_seq')),
      workspace_id varchar not null,
      space_id varchar not null,
      trigger varchar not null,
      mode varchar not null,
      knowledge_generation integer not null,
      phase varchar not null,
      status varchar not null,
      expected_page_count integer not null,
      succeeded_page_count integer not null default 0,
      failed_page_count integer not null default 0,
      skipped_page_count integer not null default 0,
      compiler_version varchar not null,
      prompt_version varchar not null,
      catalog_snapshot jsonb not null,
      catalog_hash varchar not null,
      aggregate_job_id varchar,
      aggregate_started_at timestamptz,
      imported_artifact_count integer not null default 0,
      quarantined_artifact_count integer not null default 0,
      error_code varchar,
      error_message varchar,
      queued_at timestamptz not null,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table knowledge_space_compile_run_pages (
      id varchar primary key default ('run-page-' || nextval('run_page_id_seq')),
      run_id varchar not null,
      workspace_id varchar not null,
      space_id varchar not null,
      source_page_id varchar not null,
      expected_source_version varchar not null,
      expected_source_content_hash varchar not null,
      expected_image_count integer not null default 0,
      succeeded_image_count integer not null default 0,
      failed_image_count integer not null default 0,
      skipped_image_count integer not null default 0,
      image_status varchar not null default 'not_required',
      image_job_id varchar,
      merge_status varchar not null default 'not_required',
      merge_job_id varchar,
      target_effective_knowledge_hash varchar,
      merged_effective_knowledge_hash varchar,
      status varchar not null,
      job_id varchar,
      error_code varchar,
      error_message varchar,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (run_id, source_page_id)
    );
    insert into spaces (id, workspace_id, name) values
      ('space-reused', 'workspace-1', 'Reused'),
      ('space-mixed', 'workspace-1', 'Mixed'),
      ('space-images', 'workspace-1', 'Images'),
      ('space-no-image-content', 'workspace-1', 'No image content')
  `.execute(db);
}

async function createPendingImageRun(
  repo: KnowledgeSpaceCompilationRepo,
  db: Kysely<unknown>,
  sourcePageId: string,
) {
  const result = await repo.createRun({
    workspaceId: 'workspace-1',
    spaceId: 'space-images',
    trigger: 'manual_compile',
    compilerVersion: 'compiler-v1',
    promptVersion: 'prompt-v1',
    catalogSnapshot: [],
    catalogHash: 'sha256:image-race',
    aggregateRequired: true,
    sources: [
      {
        sourcePageId,
        sourceVersion: 'v1',
        sourceContentHash: `sha256:${sourcePageId}`,
        expectedImageCount: 1,
        imageStatus: 'pending',
        mergeStatus: 'waiting_images',
      },
    ],
  });
  await sql`
    update knowledge_space_compile_run_pages
    set status = 'succeeded', finished_at = now()
    where run_id = ${result.run.id}
  `.execute(db);
  await sql`
    update knowledge_space_compile_runs
    set status = 'compiling', phase = 'images', succeeded_page_count = 1
    where id = ${result.run.id}
  `.execute(db);
  return result;
}

async function readImageDispatchState(db: Kysely<unknown>, runId: string) {
  const result = await sql<{
    imageStatus: string;
    imageJobId: string | null;
  }>`
    select image_status as "imageStatus", image_job_id as "imageJobId"
    from knowledge_space_compile_run_pages
    where run_id = ${runId}
  `.execute(db);
  return result.rows[0];
}

async function readRunEvidence(db: Kysely<unknown>, runId: string) {
  const result = await sql<{
    status: string;
    phase: string;
    expected: number;
    succeeded: number;
    failed: number;
    skipped: number;
    pageRows: number;
    pendingRows: number;
    unchangedRows: number;
  }>`
    select
      run.status,
      run.phase,
      run.expected_page_count as expected,
      run.succeeded_page_count as succeeded,
      run.failed_page_count as failed,
      run.skipped_page_count as skipped,
      count(page.id)::integer as "pageRows",
      count(*) filter (where page.status = 'pending')::integer as "pendingRows",
      count(*) filter (where page.error_code = 'unchanged')::integer as "unchangedRows"
    from knowledge_space_compile_runs run
    left join knowledge_space_compile_run_pages page on page.run_id = run.id
    where run.id = ${runId}
    group by run.id
  `.execute(db);
  return result.rows[0];
}

function logEvidence(stage: string, evidence: unknown): void {
  if (process.env.AKASHA_MIGRATION_TEST_EVIDENCE !== '1') return;
  console.info(
    'knowledge_incremental_run_database_evidence',
    JSON.stringify({ stage, evidence }),
  );
}
