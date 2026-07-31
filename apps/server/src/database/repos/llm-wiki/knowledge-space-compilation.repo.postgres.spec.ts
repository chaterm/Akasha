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

  it('coalesces concurrent requests into one queued uninitialized run', async () => {
    const request = {
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-request',
          trigger: 'manual_compile',
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    };

    const results = await Promise.all([
      repo.requestRuns(request),
      repo.requestRuns(request),
    ]);

    expect(
      results
        .flat()
        .map((result) => result.disposition)
        .sort(),
    ).toEqual(['coalesced', 'created']);
    const rows = await sql<{
      count: number;
      initializedAt: Date | null;
      pageCount: number;
    }>`
      select count(*)::integer as count,
             max(initialized_at) as "initializedAt",
             max(expected_page_count)::integer as "pageCount"
      from knowledge_space_compile_runs
      where space_id = 'space-request'
        and status in ('queued', 'compiling', 'aggregate_pending', 'aggregating')
    `.execute(db);
    expect(rows.rows).toEqual([
      { count: 1, initializedAt: null, pageCount: 0 },
    ]);
  });

  it('sets rerun_requested after initialization without creating another active run', async () => {
    const [created] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-rerun',
          trigger: 'manual_compile',
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });
    await sql`
      update knowledge_space_compile_runs
      set initialized_at = now(), status = 'compiling'
      where id = ${created.run!.id}
    `.execute(db);

    const [followUp] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-rerun',
          trigger: 'page_update',
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });

    expect(followUp.disposition).toBe('rerun_requested');
    expect(followUp.run?.id).toBe(created.run?.id);
    const state = await sql<{ rerunRequested: boolean; count: number }>`
      select bool_or(rerun_requested) as "rerunRequested",
             count(*)::integer as count
      from knowledge_space_compile_runs
      where space_id = 'space-rerun'
        and status in ('queued', 'compiling', 'aggregate_pending', 'aggregating')
    `.execute(db);
    expect(state.rows).toEqual([{ rerunRequested: true, count: 1 }]);
  });

  it('orders merge work first and puts yielded continuations behind older peers', async () => {
    await sql`
      insert into knowledge_space_compile_runs (
        id, workspace_id, space_id, trigger, mode, knowledge_generation, phase,
        status, expected_page_count, compiler_version, prompt_version,
        catalog_snapshot, catalog_hash, queued_at, initialized_at,
        space_job_queued_at
      ) values
        (
          'run-old-text', 'workspace-1', 'space-fair-old', 'manual_compile',
          'incremental', 0, 'text', 'queued', 1, 'compiler-v1', 'prompt-v1',
          '[]', 'sha256:old', now() - interval '10 minutes', now(),
          now() - interval '10 minutes'
        ),
        (
          'run-continuation', 'workspace-1', 'space-fair-continuation',
          'manual_compile', 'incremental', 0, 'text', 'queued', 6,
          'compiler-v1', 'prompt-v1', '[]', 'sha256:continuation',
          now() - interval '20 minutes', now(), now() - interval '1 minute'
        ),
        (
          'run-merge', 'workspace-1', 'space-fair-merge', 'manual_compile',
          'incremental', 0, 'image_merge', 'queued', 1, 'compiler-v1',
          'prompt-v1', '[]', 'sha256:merge', now() - interval '20 minutes',
          now(), now()
        )
    `.execute(db);

    const candidates = await repo.findSpaceSliceReservationCandidates(100);
    const relevantIds = candidates
      .map((candidate) => candidate.id)
      .filter((id) =>
        ['run-merge', 'run-old-text', 'run-continuation'].includes(id),
      );

    expect(relevantIds).toEqual([
      'run-merge',
      'run-old-text',
      'run-continuation',
    ]);
  });

  it('finds the prior completed aggregate candidate instead of the current placeholder', async () => {
    await sql`
      insert into knowledge_space_compile_runs (
        workspace_id, space_id, trigger, mode, knowledge_generation, phase,
        status, expected_page_count, compiler_version, prompt_version,
        catalog_snapshot, catalog_hash, queued_at, initialized_at
      ) values (
        'workspace-1', 'space-reuse-query', 'manual_compile', 'incremental', 0,
        'complete', 'succeeded', 0, 'compiler-v1', 'prompt-v1', '[]',
        'sha256:completed', now() - interval '1 minute', now() - interval '1 minute'
      )
    `.execute(db);
    const [current] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-reuse-query',
          trigger: 'manual_compile',
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });

    const candidate = await repo.findLatestCompletedRunForAggregateReuse({
      workspaceId: 'workspace-1',
      spaceId: 'space-reuse-query',
      currentRunId: current.run!.id,
    });

    expect(candidate).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        phase: 'complete',
        catalogHash: 'sha256:completed',
      }),
    );
    expect(candidate?.id).not.toBe(current.run?.id);
  });

  it('fail-closes removed-source artifacts and replans the same initialized run', async () => {
    const [created] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-removed',
          trigger: 'manual_compile',
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });
    await seedInitializedRemovedSourcePlan(db, created.run!.id);

    const [replanned] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-removed',
          trigger: 'page_update',
          removedSourcePageIds: ['removed-page'],
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });

    expect(replanned.disposition).toBe('coalesced');
    expect(replanned.run?.id).toBe(created.run?.id);
    const evidence = await readRemovedSourceReplanEvidence(db, created.run!.id);
    expect(evidence).toEqual({
      sourceStale: true,
      artifactStale: true,
      overviewStale: true,
      childStaleCount: 5,
      contributionCount: 1,
      initializedAt: null,
      status: 'queued',
      phase: 'text',
      sequence: 7,
      runPageCount: 0,
      runImageCount: 0,
    });
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
      knowledge_generation integer not null default 0,
      deleted_at timestamptz,
      updated_at timestamptz not null default now()
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
      updated_at timestamptz not null default now(),
      initialized_at timestamptz,
      space_job_id varchar,
      space_job_dispatched_at timestamptz,
      space_job_sequence integer not null default 0,
      space_job_queued_at timestamptz,
      space_job_recovery_count integer not null default 0,
      execution_token varchar,
      execution_lease_expires_at timestamptz,
      worker_id varchar,
      heartbeat_at timestamptz,
      last_yield_at timestamptz,
      last_yield_reason varchar,
      rerun_requested boolean not null default false
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
    create table knowledge_space_compile_run_images (
      id varchar primary key,
      run_id varchar not null,
      run_page_id varchar not null
    );
    create table pages (
      id varchar primary key,
      workspace_id varchar not null,
      space_id varchar not null,
      deleted_at timestamptz
    );
    create table knowledge_sources (
      id varchar primary key,
      workspace_id varchar not null,
      source_space_id varchar not null,
      source_page_id varchar not null,
      stale_at timestamptz
    );
    create table knowledge_artifact_contributions (
      id varchar primary key,
      workspace_id varchar not null,
      space_id varchar not null,
      source_page_id varchar not null,
      artifact_id varchar not null
    );
    create table knowledge_pages (
      id varchar primary key,
      workspace_id varchar not null,
      space_id varchar not null,
      page_type varchar,
      compile_scope varchar not null,
      stale_at timestamptz
    );
    create table knowledge_parent_sections (
      id varchar primary key,
      workspace_id varchar not null,
      knowledge_page_id varchar not null,
      stale_at timestamptz
    );
    create table knowledge_claims (
      id varchar primary key,
      workspace_id varchar not null,
      knowledge_page_id varchar not null,
      stale_at timestamptz
    );
    create table knowledge_chunks (
      id varchar primary key,
      workspace_id varchar not null,
      knowledge_page_id varchar not null,
      stale_at timestamptz
    );
    create table knowledge_links (
      id varchar primary key,
      workspace_id varchar not null,
      from_knowledge_page_id varchar not null,
      stale_at timestamptz
    );
    create table knowledge_graph_edges (
      id varchar primary key,
      workspace_id varchar not null,
      from_knowledge_page_id varchar not null,
      stale_at timestamptz
    );
    create unique index uq_active_run on knowledge_space_compile_runs (
      workspace_id, space_id
    ) where status in ('queued', 'compiling', 'aggregate_pending', 'aggregating');
    insert into spaces (id, workspace_id, name) values
      ('space-reused', 'workspace-1', 'Reused'),
      ('space-mixed', 'workspace-1', 'Mixed'),
      ('space-images', 'workspace-1', 'Images'),
      ('space-no-image-content', 'workspace-1', 'No image content'),
      ('space-request', 'workspace-1', 'Request'),
      ('space-rerun', 'workspace-1', 'Rerun'),
      ('space-reuse-query', 'workspace-1', 'Reuse query'),
      ('space-removed', 'workspace-1', 'Removed'),
      ('space-fair-old', 'workspace-1', 'Fair old'),
      ('space-fair-continuation', 'workspace-1', 'Fair continuation'),
      ('space-fair-merge', 'workspace-1', 'Fair merge')
  `.execute(db);
}

async function seedInitializedRemovedSourcePlan(
  db: Kysely<unknown>,
  runId: string,
): Promise<void> {
  await sql`
    update knowledge_space_compile_runs
    set initialized_at = now(), status = 'compiling', space_job_sequence = 7,
        execution_token = 'old-token'
    where id = ${runId}
  `.execute(db);
  await sql`
    insert into knowledge_space_compile_run_pages (
      id, run_id, workspace_id, space_id, source_page_id,
      expected_source_version, expected_source_content_hash, status
    ) values (
      'removed-run-page', ${runId}, 'workspace-1', 'space-removed',
      'removed-page', 'v1', 'sha256:removed', 'running'
    )
  `.execute(db);
  await sql`
    insert into knowledge_space_compile_run_images (id, run_id, run_page_id)
    values ('removed-run-image', ${runId}, 'removed-run-page')
  `.execute(db);
  await sql`
    insert into knowledge_sources (
      id, workspace_id, source_space_id, source_page_id
    ) values ('source-removed', 'workspace-1', 'space-removed', 'removed-page');
    insert into knowledge_pages (
      id, workspace_id, space_id, page_type, compile_scope
    ) values
      ('artifact-removed', 'workspace-1', 'space-removed', 'concept', 'page'),
      ('overview-removed', 'workspace-1', 'space-removed', 'overview', 'space');
    insert into knowledge_artifact_contributions (
      id, workspace_id, space_id, source_page_id, artifact_id
    ) values (
      'contribution-removed', 'workspace-1', 'space-removed', 'removed-page',
      'artifact-removed'
    );
    insert into knowledge_parent_sections values (
      'parent-removed', 'workspace-1', 'artifact-removed', null
    );
    insert into knowledge_claims values (
      'claim-removed', 'workspace-1', 'artifact-removed', null
    );
    insert into knowledge_chunks values (
      'chunk-removed', 'workspace-1', 'artifact-removed', null
    );
    insert into knowledge_links values (
      'link-removed', 'workspace-1', 'artifact-removed', null
    );
    insert into knowledge_graph_edges values (
      'edge-removed', 'workspace-1', 'overview-removed', null
    )
  `.execute(db);
}

async function readRemovedSourceReplanEvidence(
  db: Kysely<unknown>,
  runId: string,
) {
  const result = await sql<{
    sourceStale: boolean;
    artifactStale: boolean;
    overviewStale: boolean;
    childStaleCount: number;
    contributionCount: number;
    initializedAt: Date | null;
    status: string;
    phase: string;
    sequence: number;
    runPageCount: number;
    runImageCount: number;
  }>`
    select
      (select stale_at is not null from knowledge_sources
       where id = 'source-removed') as "sourceStale",
      (select stale_at is not null from knowledge_pages
       where id = 'artifact-removed') as "artifactStale",
      (select stale_at is not null from knowledge_pages
       where id = 'overview-removed') as "overviewStale",
      ((select count(*) from knowledge_parent_sections where stale_at is not null)
       + (select count(*) from knowledge_claims where stale_at is not null)
       + (select count(*) from knowledge_chunks where stale_at is not null)
       + (select count(*) from knowledge_links where stale_at is not null)
       + (select count(*) from knowledge_graph_edges where stale_at is not null)
      )::integer as "childStaleCount",
      (select count(*)::integer from knowledge_artifact_contributions
       where id = 'contribution-removed') as "contributionCount",
      run.initialized_at as "initializedAt", run.status, run.phase,
      run.space_job_sequence as sequence,
      (select count(*)::integer from knowledge_space_compile_run_pages
       where run_id = run.id) as "runPageCount",
      (select count(*)::integer from knowledge_space_compile_run_images
       where run_id = run.id) as "runImageCount"
    from knowledge_space_compile_runs run
    where run.id = ${runId}
  `.execute(db);
  return result.rows[0];
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
