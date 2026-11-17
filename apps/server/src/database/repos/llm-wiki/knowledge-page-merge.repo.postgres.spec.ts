import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import {
  buildPageMergeJobId,
  KnowledgeSpaceExecutionRepo,
  PageMergeExecutionFence,
} from './knowledge-space-execution.repo';

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('KnowledgeSpaceExecutionRepo page merge fencing', () => {
  const schema = `akasha_page_merge_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: KnowledgeSpaceExecutionRepo;

  beforeAll(async () => {
    client = postgres(normalizePostgresUrl(integrationDatabaseUrl!), {
      max: 4,
      connection: { search_path: schema },
      onnotice: () => {},
    });
    db = new Kysely({
      dialect: new PostgresJSDialect({ postgres: client }),
      plugins: [new CamelCasePlugin()],
    });
    await sql.raw(`create schema "${schema}"`).execute(db);
    await sql.raw(`set search_path to "${schema}"`).execute(db);
    await createFixture(db);
    repo = new KnowledgeSpaceExecutionRepo(db as never);
  });

  afterEach(async () => {
    await resetMergeState(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('reserves at most one ready page per run in stable order', async () => {
    const reservations = await repo.reservePageMergesFairly();
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        runPageId: 'page-a',
        sourcePageId: 'src-a',
        knowledgeGeneration: 0,
        mergeJobId: buildPageMergeJobId('run-1', 'page-a', 0),
      }),
    );
    expect(await mergeStatusOf(db, 'page-a')).toBe('queued');
    expect(await repo.reservePageMergesFairly()).toHaveLength(0);
  });

  it('does not reserve pages still waiting on images', async () => {
    await sql`
      update knowledge_space_compile_run_pages set merge_status = 'succeeded'
        where id in ('page-a', 'page-b')
    `.execute(db);
    expect(await repo.reservePageMergesFairly()).toHaveLength(0);
  });

  it('claims a reserved page, minting a fresh fence with frozen images', async () => {
    const [reservation] = await repo.reservePageMergesFairly();
    await repo.markPageMergeDispatched(reservation);
    const claimed = await repo.claimPageMerge({
      runId: 'run-1',
      runPageId: reservation.runPageId,
      knowledgeGeneration: 0,
      mergeJobId: reservation.mergeJobId,
      workerId: 'worker-1',
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    expect(claimed).toEqual(
      expect.objectContaining({
        runPageId: 'page-a',
        sourcePageId: 'src-a',
        sourceVersion: 'v1',
        sourceContentHash: 'sha:a',
        mergeAttemptCount: 1,
        expectedExtractionIds: ['ext-a'],
      }),
    );
    expect(claimed!.mergeExecutionToken).toEqual(expect.any(String));
    expect(claimed!.images).toHaveLength(1);
    expect(await mergeStatusOf(db, 'page-a')).toBe('running');
    expect(await repo.isPageMergeFenceActive(claimed!)).toBe(true);
  });

  it('rejects publication and heartbeat for a superseded execution token', async () => {
    const [reservation] = await repo.reservePageMergesFairly();
    const claimed = await repo.claimPageMerge({
      runId: 'run-1',
      runPageId: reservation.runPageId,
      knowledgeGeneration: 0,
      mergeJobId: reservation.mergeJobId,
      workerId: 'worker-1',
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    const stale: PageMergeExecutionFence = {
      ...claimed!,
      mergeExecutionToken: 'stale-token',
    };
    expect(await repo.isPageMergeFenceActive(stale)).toBe(false);
    expect(
      await repo.heartbeatPageMerge(stale, {
        processingExpiresAt: new Date(Date.now() + 120_000),
      }),
    ).toBe(false);
    const staleGuard = await db
      .transaction()
      .execute((trx) =>
        repo.isPageMergeFenceActiveForPublication(stale, trx as never),
      );
    expect(staleGuard).toBe(false);
    const liveGuard = await db
      .transaction()
      .execute((trx) =>
        repo.isPageMergeFenceActiveForPublication(claimed!, trx as never),
      );
    expect(liveGuard).toBe(true);
  });

  it('publishes a successful merge, clears the fence, and advances the barrier', async () => {
    await sql`
      update knowledge_space_compile_run_pages set merge_status = 'succeeded'
        where id = 'page-b';
      update knowledge_space_compile_run_pages set merge_status = 'not_required'
        where id = 'page-c';
    `.execute(db);
    const [reservation] = await repo.reservePageMergesFairly();
    const claimed = await repo.claimPageMerge({
      runId: 'run-1',
      runPageId: reservation.runPageId,
      knowledgeGeneration: 0,
      mergeJobId: reservation.mergeJobId,
      workerId: 'worker-1',
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    const published = await db
      .transaction()
      .execute((trx) =>
        repo.completePageMerge(
          claimed!,
          { effectiveKnowledgeHash: 'hash-a' },
          trx as never,
        ),
      );
    expect(published).toBe(true);
    expect(await mergeStatusOf(db, 'page-a')).toBe('succeeded');
    const run = await sql<{ phase: string; status: string }>`
      select phase, status from knowledge_space_compile_runs where id = 'run-1'
    `.execute(db);
    expect(run.rows[0]).toEqual({ phase: 'finalizing', status: 'queued' });
  });

  it('keeps the run slot on a retryable failure and frees it when terminal', async () => {
    const [reservation] = await repo.reservePageMergesFairly();
    const claimed = await repo.claimPageMerge({
      runId: 'run-1',
      runPageId: reservation.runPageId,
      knowledgeGeneration: 0,
      mergeJobId: reservation.mergeJobId,
      workerId: 'worker-1',
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    const retry = await repo.finishPageMerge(claimed!, {
      status: 'failed',
      retryable: true,
    });
    expect(retry).toEqual({ terminal: false });
    expect(await mergeStatusOf(db, 'page-a')).toBe('queued');
    expect(await repo.reservePageMergesFairly()).toHaveLength(0);
    const reclaimed = await repo.claimPageMerge({
      runId: 'run-1',
      runPageId: reservation.runPageId,
      knowledgeGeneration: 0,
      mergeJobId: reservation.mergeJobId,
      workerId: 'worker-1',
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    expect(reclaimed!.mergeAttemptCount).toBe(2);
    const secondRetry = await repo.finishPageMerge(reclaimed!, {
      status: 'failed',
      retryable: true,
    });
    expect(secondRetry).toEqual({ terminal: false });
    expect(await repo.reservePageMergesFairly()).toHaveLength(0);
    const third = await repo.claimPageMerge({
      runId: 'run-1',
      runPageId: reservation.runPageId,
      knowledgeGeneration: 0,
      mergeJobId: reservation.mergeJobId,
      workerId: 'worker-1',
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    expect(third!.mergeAttemptCount).toBe(3);
    const terminal = await repo.finishPageMerge(third!, {
      status: 'failed',
      retryable: true,
    });
    expect(terminal).toEqual({ terminal: true });
    expect(await mergeStatusOf(db, 'page-a')).toBe('failed');
    const next = await repo.reservePageMergesFairly();
    expect(next).toHaveLength(1);
    expect(next[0].runPageId).toBe('page-b');
  });

  it('enforces a single outstanding merge per run at the database level', async () => {
    await repo.reservePageMergesFairly();
    await expect(
      sql`
        update knowledge_space_compile_run_pages set merge_status = 'queued'
          where id = 'page-b'
      `.execute(db),
    ).rejects.toThrow(/uq_one_outstanding_merge|unique/i);
  });

  it.each(['queued', 'running'] as const)(
    'Text barrier waits for a %s Merge and keeps its fence valid',
    async (status) => {
      const lease = await startTextLease();
      await sql`update knowledge_space_compile_run_pages set merge_status = 'not_required' where id != 'page-a'`.execute(
        db,
      );
      const [reservation] = await repo.reservePageMergesFairly();
      const fence =
        status === 'running'
          ? await repo.claimPageMerge({
              ...reservation,
              workerId: 'worker-1',
              processingExpiresAt: new Date(Date.now() + 120_000),
            })
          : undefined;
      expect(await repo.advanceTextBarrier(lease!)).toMatchObject({
        barrierComplete: true,
        mergeRequired: true,
        readyToFinalize: false,
        phase: 'image_merge',
      });
      expect(await runState()).toMatchObject({
        phase: 'image_merge',
        status: 'compiling',
        spaceJobId: null,
        executionToken: null,
      });
      if (fence) expect(await repo.isPageMergeFenceActive(fence)).toBe(true);
    },
  );

  it('Merge can publish during Text without consuming the Text lease', async () => {
    const lease = await startTextLease();
    await sql`update knowledge_space_compile_run_pages set merge_status = 'not_required' where id != 'page-a'`.execute(
      db,
    );
    const [reservation] = await repo.reservePageMergesFairly();
    const fence = await repo.claimPageMerge({
      ...reservation,
      workerId: 'merge-1',
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    await db
      .transaction()
      .execute((trx) =>
        repo.completePageMerge(
          fence!,
          { effectiveKnowledgeHash: 'during-text' },
          trx as never,
        ),
      );
    expect(await repo.isLeaseActive(lease!)).toBe(true);
    expect(await runState()).toMatchObject({
      phase: 'text',
      executionToken: lease!.executionToken,
      spaceJobId: lease!.spaceJobId,
    });
    expect(await repo.advanceTextBarrier(lease!)).toMatchObject({
      readyToFinalize: true,
    });
    expect(await runState()).toMatchObject({
      phase: 'finalizing',
      status: 'queued',
      spaceJobId: null,
      executionToken: null,
    });
  });

  it('the last Merge cannot finalize while Text rows are still open', async () => {
    await sql`
      update knowledge_space_compile_run_pages set merge_status = 'not_required' where id != 'page-a';
      update knowledge_space_compile_run_pages set status = 'pending' where id = 'page-b';
      update knowledge_space_compile_runs set succeeded_page_count = 2;
    `.execute(db);
    const [reservation] = await repo.reservePageMergesFairly();
    const fence = await repo.claimPageMerge({
      ...reservation,
      workerId: 'merge-1',
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    await db
      .transaction()
      .execute((trx) =>
        repo.completePageMerge(
          fence!,
          { effectiveKnowledgeHash: 'waiting-text' },
          trx as never,
        ),
      );
    expect((await runState()).phase).toBe('image_merge');
  });

  it('an expired observation cannot invalidate a renewed heartbeat or a fresh retry token', async () => {
    const [reservation] = await repo.reservePageMergesFairly();
    const fence = await repo.claimPageMerge({
      ...reservation,
      workerId: 'old-worker',
      processingExpiresAt: new Date(Date.now() - 1_000),
    });
    const observation = await recoveryObservation();
    await repo.heartbeatPageMerge(fence!, {
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    expect(await repo.requeueMissingPageMerge(observation)).toBe(false);
    expect(
      await repo.terminalizePageMerge({
        ...observation,
        errorCode: 'missing',
        errorMessage: 'stale',
      }),
    ).toBe(false);
    await repo.finishPageMerge(fence!, { status: 'failed', retryable: true });
    const retry = await repo.claimPageMerge({
      ...reservation,
      workerId: 'new-worker',
      processingExpiresAt: new Date(Date.now() + 120_000),
    });
    expect(retry!.mergeExecutionToken).not.toBe(fence!.mergeExecutionToken);
    expect(await repo.requeueMissingPageMerge(observation)).toBe(false);
    expect(await repo.isPageMergeFenceActive(retry!)).toBe(true);
  });

  it('concurrent reapers consume the last transport recovery only once', async () => {
    const [reservation] = await repo.reservePageMergesFairly();
    await repo.claimPageMerge({
      ...reservation,
      workerId: 'dead-worker',
      processingExpiresAt: new Date(Date.now() - 1_000),
    });
    await sql`update knowledge_space_compile_run_pages set merge_redis_recovery_count = 2 where id = ${reservation.runPageId}`.execute(
      db,
    );
    const observation = await recoveryObservation();
    expect(
      (
        await Promise.all([
          repo.requeueMissingPageMerge(observation),
          repo.requeueMissingPageMerge(observation),
        ])
      ).sort(),
    ).toEqual([false, true]);
    const state = await sql<{
      count: number;
    }>`select merge_redis_recovery_count as count from knowledge_space_compile_run_pages where id = ${reservation.runPageId}`.execute(
      db,
    );
    expect(state.rows[0].count).toBe(3);
  });

  it('Finalize refuses an open child even if the Run phase was incorrectly advanced', async () => {
    await sql`update knowledge_space_compile_runs set phase = 'finalizing', status = 'queued', space_job_id = 'finalize-test', space_job_sequence = 1`.execute(
      db,
    );
    expect(
      await repo.claimSpaceLease({
        runId: 'run-1',
        knowledgeGeneration: 0,
        jobPhase: 'finalize',
        spaceJobId: 'finalize-test',
        spaceJobSequence: 1,
        workerId: 'finalizer',
        executionLeaseExpiresAt: new Date(Date.now() + 120_000),
      }),
    ).toBeUndefined();
  });

  it('terminalizes a lost third execution instead of granting a fourth attempt', async () => {
    const [reservation] = await repo.reservePageMergesFairly();
    let lastFence: PageMergeExecutionFence | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const fence = await repo.claimPageMerge({
        ...reservation,
        workerId: `attempt-${attempt}`,
        processingExpiresAt: new Date(Date.now() - 1_000),
      });
      expect(fence!.mergeAttemptCount).toBe(attempt);
      lastFence = fence;
      const observation = await recoveryObservation();
      expect(await repo.requeueMissingPageMerge(observation)).toBe(true);
      expect(await repo.requeueMissingPageMerge(observation)).toBe(false);
    }
    expect(await repo.isPageMergeFenceActive(lastFence!)).toBe(false);
    expect(
      await repo.claimPageMerge({
        ...reservation,
        workerId: 'fourth-worker',
        processingExpiresAt: new Date(Date.now() + 120_000),
      }),
    ).toBeUndefined();
    const state = await sql<{
      mergeStatus: string;
      mergeAttemptCount: number;
      mergeRedisRecoveryCount: number;
      mergeFailureClass: string;
      qualityStatus: string;
      mergeExecutionToken: string | null;
      errorCode: string;
    }>`select merge_status, merge_attempt_count, merge_redis_recovery_count,
        merge_failure_class, quality_status, merge_execution_token, error_code
       from knowledge_space_compile_run_pages where id = ${reservation.runPageId}`.execute(
      db,
    );
    expect(state.rows[0]).toEqual({
      mergeStatus: 'failed',
      mergeAttemptCount: 3,
      mergeRedisRecoveryCount: 2,
      mergeFailureClass: 'retryable_exhausted',
      qualityStatus: 'partial_image',
      mergeExecutionToken: null,
      errorCode: 'merge_job_attempts_exhausted',
    });
    expect((await repo.reservePageMergesFairly())[0].runPageId).toBe('page-b');
  });

  it('rejects and settles an exhausted queued delivery and finalizes partial', async () => {
    const [reservation] = await repo.reservePageMergesFairly();
    await sql`
      update knowledge_space_compile_run_pages set merge_attempt_count = 3
        where id = ${reservation.runPageId}
    `.execute(db);
    await sql`
      update knowledge_space_compile_run_pages set merge_status = 'not_required'
        where id <> ${reservation.runPageId}
    `.execute(db);
    expect(
      await repo.claimPageMerge({
        ...reservation,
        workerId: 'duplicate-worker',
        processingExpiresAt: new Date(Date.now() + 120_000),
      }),
    ).toBeUndefined();
    expect(await mergeStatusOf(db, reservation.runPageId)).toBe('failed');
    expect(await runState()).toEqual(
      expect.objectContaining({
        phase: 'finalizing',
        status: 'queued',
        executionToken: null,
      }),
    );
    await sql`update knowledge_space_compile_runs set space_job_id = 'finalize-budget', space_job_sequence = 1`.execute(
      db,
    );
    const lease = await repo.claimSpaceLease({
      runId: reservation.runId,
      knowledgeGeneration: reservation.knowledgeGeneration,
      jobPhase: 'finalize',
      spaceJobId: 'finalize-budget',
      spaceJobSequence: 1,
      workerId: 'finalizer',
      executionLeaseExpiresAt: new Date(Date.now() + 120_000),
    });
    expect((await repo.finishRun(lease!, 'succeeded'))!.run.status).toBe(
      'partial',
    );
  });

  async function startTextLease() {
    await sql`update knowledge_space_compile_runs set phase = 'text', status = 'queued', space_job_id = 'text-test', space_job_sequence = 1`.execute(
      db,
    );
    return repo.claimSpaceLease({
      runId: 'run-1',
      knowledgeGeneration: 0,
      jobPhase: 'text',
      spaceJobId: 'text-test',
      spaceJobSequence: 1,
      workerId: 'text-worker',
      executionLeaseExpiresAt: new Date(Date.now() + 120_000),
    });
  }

  async function runState() {
    return (
      await sql<{
        phase: string;
        status: string;
        spaceJobId: string | null;
        executionToken: string | null;
      }>`select phase, status, space_job_id, execution_token from knowledge_space_compile_runs where id = 'run-1'`.execute(
        db,
      )
    ).rows[0];
  }

  async function recoveryObservation() {
    const observedAt = new Date();
    const queuedDispatchedBefore = new Date(Date.now() - 120_000);
    const [candidate] = await repo.findPageMergeRecoveryCandidates({
      processingExpiredBefore: observedAt,
      queuedDispatchedBefore,
    });
    if (!candidate?.mergeJobId) throw new Error('Expected expired Merge');
    return {
      ...candidate,
      mergeJobId: candidate.mergeJobId,
      observedAt,
      queuedDispatchedBefore,
    };
  }
});

async function createFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table spaces (
      id varchar primary key,
      workspace_id varchar not null,
      knowledge_generation integer not null default 0,
      deleted_at timestamptz
    );
    create table knowledge_space_compile_runs (
      id varchar primary key,
      workspace_id varchar not null,
      space_id varchar not null,
      knowledge_generation integer not null default 0,
      phase varchar not null default 'text',
      status varchar not null default 'compiling',
      expected_page_count integer not null default 0,
      succeeded_page_count integer not null default 0,
      failed_page_count integer not null default 0,
      skipped_page_count integer not null default 0,
      trigger varchar not null default 'manual',
      mode varchar not null default 'incremental',
      compiler_version varchar not null default 'compiler-v1',
      prompt_version varchar not null default 'prompt-v1',
      rerun_requested boolean not null default false,
      follow_up_target_source_page_ids jsonb,
      space_job_sequence integer not null default 0,
      space_job_recovery_count integer not null default 0,
      started_at timestamptz,
      finished_at timestamptz,
      error_code varchar,
      error_message varchar,
      space_job_id varchar,
      space_job_dispatched_at timestamptz,
      space_job_queued_at timestamptz,
      execution_token varchar,
      execution_lease_expires_at timestamptz,
      worker_id varchar,
      heartbeat_at timestamptz,
      updated_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    );
    create table knowledge_space_compile_run_pages (
      id varchar primary key,
      run_id varchar not null,
      workspace_id varchar not null,
      space_id varchar not null,
      source_page_id varchar not null,
      binding_status varchar not null default 'bound',
      expected_source_version varchar,
      expected_source_content_hash varchar,
      quality_status varchar not null default 'normal',
      merge_status varchar not null default 'not_required',
      merge_job_id varchar,
      merged_effective_knowledge_hash varchar,
      merge_attempt_count integer not null default 0,
      merge_dispatched_at timestamptz,
      merge_processing_expires_at timestamptz,
      merge_redis_recovery_count integer not null default 0,
      merge_failure_class varchar,
      merge_execution_token varchar,
      merge_worker_id varchar,
      merge_heartbeat_at timestamptz,
      status varchar not null default 'pending',
      image_status varchar not null default 'not_required',
      attempt_count integer not null default 0,
      finished_at timestamptz,
      error_code varchar,
      error_message varchar,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (run_id, source_page_id)
    );
    create unique index uq_one_outstanding_merge
      on knowledge_space_compile_run_pages (run_id)
      where merge_status in ('queued', 'running');
    create table knowledge_space_compile_run_images (
      id varchar primary key,
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
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `.execute(db);
  await seedRun(db);
}

async function seedRun(db: Kysely<unknown>): Promise<void> {
  await sql`
    insert into spaces (id, workspace_id, knowledge_generation)
      values ('space-1', 'ws-1', 0);
    insert into knowledge_space_compile_runs (
      id, workspace_id, space_id, knowledge_generation, phase, status,
      expected_page_count, succeeded_page_count
    ) values (
      'run-1', 'ws-1', 'space-1', 0, 'image_merge', 'compiling', 3, 3
    );
    insert into knowledge_space_compile_run_pages (
      id, run_id, workspace_id, space_id, source_page_id, binding_status,
      expected_source_version, expected_source_content_hash, merge_status,
      created_at
    ) values
      ('page-a', 'run-1', 'ws-1', 'space-1', 'src-a', 'bound',
       'v1', 'sha:a', 'pending', now() - interval '3 minutes'),
      ('page-b', 'run-1', 'ws-1', 'space-1', 'src-b', 'bound',
       'v1', 'sha:b', 'pending', now() - interval '2 minutes'),
      ('page-c', 'run-1', 'ws-1', 'space-1', 'src-c', 'bound',
       'v1', 'sha:c', 'waiting_images', now() - interval '1 minute');
    insert into knowledge_space_compile_run_images (
      id, run_id, run_page_id, workspace_id, space_id, source_page_id,
      attachment_id, image_ordinal, file_name, mime_type,
      expected_attachment_version, status, extraction_id
    ) values
      ('img-a', 'run-1', 'page-a', 'ws-1', 'space-1', 'src-a',
       'att-a', 0, 'a.png', 'image/png', now(), 'succeeded', 'ext-a');
    update knowledge_space_compile_run_pages set status = 'succeeded';
  `.execute(db);
}

async function resetMergeState(db: Kysely<unknown>): Promise<void> {
  await sql`
    update knowledge_space_compile_run_pages
      set merge_status = case source_page_id
            when 'src-c' then 'waiting_images' else 'pending' end,
          merge_job_id = null,
          merged_effective_knowledge_hash = null,
          merge_attempt_count = 0,
          merge_dispatched_at = null,
          merge_processing_expires_at = null,
          merge_redis_recovery_count = 0,
          merge_failure_class = null,
          merge_execution_token = null,
          merge_worker_id = null,
          merge_heartbeat_at = null,
          quality_status = 'normal'
      where run_id = 'run-1';
    update knowledge_space_compile_runs
      set phase = 'image_merge', status = 'compiling', space_job_id = null,
          space_job_sequence = 0, space_job_dispatched_at = null, space_job_queued_at = null,
          succeeded_page_count = 3, failed_page_count = 0, skipped_page_count = 0,
          rerun_requested = false, follow_up_target_source_page_ids = null,
          execution_token = null, execution_lease_expires_at = null
      where id = 'run-1';
    update spaces set knowledge_generation = 0 where id = 'space-1';
    update knowledge_space_compile_run_pages set status = 'succeeded', image_status = 'not_required', attempt_count = 0;
  `.execute(db);
}

async function mergeStatusOf(
  db: Kysely<unknown>,
  runPageId: string,
): Promise<string> {
  const row = await sql<{ mergeStatus: string }>`
    select merge_status from knowledge_space_compile_run_pages
      where id = ${runPageId}
  `.execute(db);
  return row.rows[0]!.mergeStatus;
}
