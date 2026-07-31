import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeSpaceCompilationRepo } from './knowledge-space-compilation.repo';
import {
  KnowledgeSpaceExecutionRepo,
  SpaceExecutionLease,
} from './knowledge-space-execution.repo';

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('KnowledgeSpaceExecutionRepo PostgreSQL fencing', () => {
  const schema = `akasha_space_execution_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let compilationRepo: KnowledgeSpaceCompilationRepo;
  let executionRepo: KnowledgeSpaceExecutionRepo;

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
    compilationRepo = new KnowledgeSpaceCompilationRepo(db as never);
    executionRepo = new KnowledgeSpaceExecutionRepo(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('reserves one sequence, claims it, and rejects stale heartbeat identities', async () => {
    const reservations = await Promise.all([
      compilationRepo.reserveNextSpaceSlice({ runId: 'run-text' }),
      compilationRepo.reserveNextSpaceSlice({ runId: 'run-text' }),
    ]);
    const reserved = reservations.find(Boolean)!;
    expect(reservations.filter(Boolean)).toHaveLength(1);
    expect(reserved.spaceJobSequence).toBe(1);

    const lease = await executionRepo.claimSpaceSlice({
      ...reserved,
      workerId: 'worker-1',
      executionToken: 'token-1',
      executionLeaseExpiresAt: new Date(Date.now() + 180_000),
    });
    expect(lease).toEqual<SpaceExecutionLease>({
      runId: 'run-text',
      knowledgeGeneration: 0,
      jobPhase: 'text',
      spaceJobSequence: 1,
      spaceJobId: reserved.spaceJobId,
      executionToken: 'token-1',
    });

    await expect(
      executionRepo.heartbeatSpaceSlice(lease!, {
        executionLeaseExpiresAt: new Date(Date.now() + 180_000),
      }),
    ).resolves.toBe(true);
    await expect(
      executionRepo.heartbeatSpaceSlice(
        { ...lease!, executionToken: 'stale-token' },
        { executionLeaseExpiresAt: new Date(Date.now() + 180_000) },
      ),
    ).resolves.toBe(false);
  });

  it('initializes once, checkpoints pages, and finishes with one incremental follow-up', async () => {
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-finish',
      'finish-token',
    );
    const initialized = await executionRepo.initializeRun(lease, {
      catalogSnapshot: [],
      catalogHash: 'sha256:catalog',
      pages: [
        {
          sourcePageId: 'page-1',
          expectedSourceVersion: 'v1',
          expectedSourceContentHash: 'sha256:page-1',
          expectedImageCount: 0,
          status: 'pending',
          imageStatus: 'not_required',
          mergeStatus: 'not_required',
        },
      ],
      images: [],
      removedSourcePageIds: [],
    });
    expect(initialized?.initialized).toBe(true);
    await expect(
      executionRepo.initializeRun(
        { ...lease, executionToken: 'old-token' },
        {
          catalogSnapshot: [],
          catalogHash: 'ignored',
          pages: [],
          images: [],
          removedSourcePageIds: [],
        },
      ),
    ).resolves.toBeUndefined();

    const checkpoint = await executionRepo.completeTextPage(lease, {
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:page-1',
      status: 'succeeded',
    });
    expect(checkpoint).toEqual(
      expect.objectContaining({ barrierComplete: true, succeededPageCount: 1 }),
    );
    await sql`
      update knowledge_space_compile_runs
      set rerun_requested = true
      where id = 'run-finish'
    `.execute(db);

    const finished = await executionRepo.finishRun(lease, 'succeeded');
    expect(finished?.run.status).toBe('succeeded');
    expect(finished?.followUp).toEqual(
      expect.objectContaining({ mode: 'incremental', knowledgeGeneration: 0 }),
    );
    await expect(
      executionRepo.heartbeatSpaceSlice(lease, {
        executionLeaseExpiresAt: new Date(Date.now() + 180_000),
      }),
    ).resolves.toBe(false);
  });

  it('yields only at a checkpoint with remaining pages and preserves progress', async () => {
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-yield',
      'yield-token',
    );
    await executionRepo.initializeRun(lease, {
      catalogSnapshot: [],
      catalogHash: 'sha256:yield',
      pages: [pagePlan('yield-page-1'), pagePlan('yield-page-2')],
      images: [],
      removedSourcePageIds: [],
    });
    await executionRepo.completeTextPage(lease, {
      sourcePageId: 'yield-page-1',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:yield-page-1',
      status: 'succeeded',
    });

    await expect(
      executionRepo.yieldSpaceSlice(lease, { reason: 'page_limit' }),
    ).resolves.toBe(true);
    const continuation = await compilationRepo.reserveNextSpaceSlice({
      runId: 'run-yield',
    });
    expect(continuation?.spaceJobSequence).toBe(2);
    const progress = await sql<{ succeeded: number; pending: number }>`
      select
        count(*) filter (where status = 'succeeded')::integer as succeeded,
        count(*) filter (where status = 'pending')::integer as pending
      from knowledge_space_compile_run_pages where run_id = 'run-yield'
    `.execute(db);
    expect(progress.rows).toEqual([{ succeeded: 1, pending: 1 }]);
  });

  it('uses a recovery lease to requeue one missing exact job with a new sequence', async () => {
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-recovery',
      'live-token',
    );
    await sql`
      update knowledge_space_compile_runs
      set execution_lease_expires_at = now() - interval '1 minute'
      where id = 'run-recovery'
    `.execute(db);
    const recovery = await executionRepo.claimRecoveryLease({
      runId: lease.runId,
      knowledgeGeneration: lease.knowledgeGeneration,
      jobPhase: lease.jobPhase,
      spaceJobSequence: lease.spaceJobSequence,
      spaceJobId: lease.spaceJobId,
      workerId: 'reaper-1',
      executionToken: 'recovery-token',
      leaseExpiredBefore: new Date(),
      executionLeaseExpiresAt: new Date(Date.now() + 180_000),
    });
    expect(recovery?.executionToken).toBe('recovery-token');
    await expect(
      executionRepo.requeueMissingSpaceSlice(recovery!),
    ).resolves.toBe(true);
    const next = await compilationRepo.reserveNextSpaceSlice({
      runId: 'run-recovery',
    });
    expect(next?.spaceJobSequence).toBe(2);
    const state = await sql<{ recoveryCount: number }>`
      select space_job_recovery_count as "recoveryCount"
      from knowledge_space_compile_runs where id = 'run-recovery'
    `.execute(db);
    expect(state.rows).toEqual([{ recoveryCount: 1 }]);
  });
});

async function claimedLease(
  compilationRepo: KnowledgeSpaceCompilationRepo,
  executionRepo: KnowledgeSpaceExecutionRepo,
  runId: string,
  token: string,
): Promise<SpaceExecutionLease> {
  const reservation = await compilationRepo.reserveNextSpaceSlice({ runId });
  return (await executionRepo.claimSpaceSlice({
    ...reservation!,
    workerId: 'worker-1',
    executionToken: token,
    executionLeaseExpiresAt: new Date(Date.now() + 180_000),
  }))!;
}

function pagePlan(sourcePageId: string) {
  return {
    sourcePageId,
    expectedSourceVersion: 'v1',
    expectedSourceContentHash: `sha256:${sourcePageId}`,
    expectedImageCount: 0,
    status: 'pending' as const,
    imageStatus: 'not_required' as const,
    mergeStatus: 'not_required' as const,
  };
}

async function createFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create sequence run_seq;
    create sequence run_page_seq;
    create sequence run_image_seq;
    create table spaces (
      id varchar primary key,
      workspace_id varchar not null,
      name varchar not null,
      knowledge_generation integer not null default 0,
      deleted_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create table knowledge_space_compile_runs (
      id varchar primary key default ('run-' || nextval('run_seq')),
      workspace_id varchar not null,
      space_id varchar not null,
      trigger varchar not null,
      mode varchar not null default 'incremental',
      knowledge_generation integer not null default 0,
      phase varchar not null default 'text',
      status varchar not null default 'queued',
      expected_page_count integer not null default 0,
      succeeded_page_count integer not null default 0,
      failed_page_count integer not null default 0,
      skipped_page_count integer not null default 0,
      compiler_version varchar not null,
      prompt_version varchar not null,
      catalog_snapshot jsonb not null default '[]',
      catalog_hash varchar not null,
      aggregate_job_id varchar,
      aggregate_started_at timestamptz,
      imported_artifact_count integer not null default 0,
      quarantined_artifact_count integer not null default 0,
      error_code varchar,
      error_message varchar,
      queued_at timestamptz not null default now(),
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
    create unique index uq_active_space_run
      on knowledge_space_compile_runs (workspace_id, space_id)
      where status in ('queued','compiling','aggregate_pending','aggregating');
    create table knowledge_space_compile_run_pages (
      id varchar primary key default ('run-page-' || nextval('run_page_seq')),
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
      merge_status varchar not null default 'not_required',
      target_effective_knowledge_hash varchar,
      merged_effective_knowledge_hash varchar,
      status varchar not null default 'pending',
      error_code varchar,
      error_message varchar,
      queued_at timestamptz,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (run_id, source_page_id)
    );
    create table knowledge_space_compile_run_images (
      id varchar primary key default ('run-image-' || nextval('run_image_seq')),
      run_id varchar not null,
      run_page_id varchar not null,
      workspace_id varchar not null,
      space_id varchar not null,
      source_page_id varchar not null,
      attachment_id varchar not null,
      image_ordinal integer not null,
      file_name varchar not null,
      mime_type varchar not null,
      file_size bigint,
      alt_text text,
      expected_attachment_version timestamptz not null,
      status varchar not null default 'pending',
      extraction_id varchar,
      attempt_count integer not null default 0,
      redis_recovery_count integer not null default 0,
      failure_class varchar,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
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
      stale_at timestamptz
    );
    insert into spaces (id, workspace_id, name) values
      ('space-text', 'workspace-1', 'Text'),
      ('space-finish', 'workspace-1', 'Finish'),
      ('space-yield', 'workspace-1', 'Yield'),
      ('space-recovery', 'workspace-1', 'Recovery');
    insert into knowledge_space_compile_runs (
      id, workspace_id, space_id, trigger, compiler_version, prompt_version,
      catalog_hash, space_job_queued_at
    ) values
      ('run-text', 'workspace-1', 'space-text', 'manual', 'compiler-v1',
       'prompt-v1', 'pending-initialization', now()),
      ('run-finish', 'workspace-1', 'space-finish', 'manual', 'compiler-v1',
       'prompt-v1', 'pending-initialization', now()),
      ('run-yield', 'workspace-1', 'space-yield', 'manual', 'compiler-v1',
       'prompt-v1', 'pending-initialization', now()),
      ('run-recovery', 'workspace-1', 'space-recovery', 'manual', 'compiler-v1',
       'prompt-v1', 'pending-initialization', now())
  `.execute(db);
}
