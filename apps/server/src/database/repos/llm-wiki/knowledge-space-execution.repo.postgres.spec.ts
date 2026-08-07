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
  const executedSql: string[] = [];

  beforeAll(async () => {
    client = postgres(normalizePostgresUrl(integrationDatabaseUrl!), {
      max: 1,
      onnotice: () => {},
    });
    db = new Kysely({
      dialect: new PostgresJSDialect({ postgres: client }),
      plugins: [new CamelCasePlugin()],
      log(event) {
        if (event.level === 'query') executedSql.push(event.query.sql);
      },
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
      aggregateRequired: true,
      targetSourcePageIds: null,
    });
    expect(initialized?.initialized).toBe(true);
    await expect(
      executionRepo.initializeRun(
        { ...lease, executionToken: 'old-token' },
        {
          aggregateRequired: true,
          targetSourcePageIds: null,
        },
      ),
    ).resolves.toBeUndefined();

    await expect(executionRepo.claimNextTextPage(lease)).resolves.toEqual(
      expect.objectContaining({
        sourcePageId: 'page-1',
        bindingStatus: 'binding',
        expectedSourceContentHash: null,
      }),
    );
    await expect(
      executionRepo.bindTextPage(
        { ...lease, executionToken: 'stale-binding-token' },
        { ...pagePlan('page-1'), images: [] },
      ),
    ).resolves.toBeUndefined();
    await executionRepo.bindTextPage(lease, {
      ...pagePlan('page-1'),
      images: [],
    });
    const bound = await sql<{
      bindingStatus: string;
      expectedSourceContentHash: string;
      expectedImageCount: number;
    }>`
      select binding_status as "bindingStatus",
             expected_source_content_hash as "expectedSourceContentHash",
             expected_image_count as "expectedImageCount"
      from knowledge_space_compile_run_pages
      where run_id = 'run-finish' and source_page_id = 'page-1'
    `.execute(db);
    expect(bound.rows).toEqual([
      {
        bindingStatus: 'bound',
        expectedSourceContentHash: 'sha256:page-1',
        expectedImageCount: 0,
      },
    ]);

    const checkpoint = await executionRepo.completeTextPage(lease, {
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:page-1',
      status: 'succeeded',
    });
    expect(checkpoint).toEqual(
      expect.objectContaining({ barrierComplete: true, succeededPageCount: 1 }),
    );
    await expect(executionRepo.advanceTextBarrier(lease)).resolves.toEqual(
      expect.objectContaining({
        barrierComplete: true,
        succeeded: 1,
        failed: 0,
        skipped: 0,
      }),
    );
    await sql`
      update knowledge_space_compile_runs
      set rerun_requested = true,
          target_source_page_ids = '["page-1", "page-2"]'::jsonb
      where id = 'run-finish'
    `.execute(db);

    const finished = await executionRepo.finishRun(lease, 'succeeded');
    expect(finished?.run.status).toBe('succeeded');
    expect(finished?.followUp).toEqual(
      expect.objectContaining({
        mode: 'incremental',
        knowledgeGeneration: 0,
        targetSourcePageIds: ['page-1', 'page-2'],
      }),
    );
    await expect(
      executionRepo.heartbeatSpaceSlice(lease, {
        executionLeaseExpiresAt: new Date(Date.now() + 180_000),
      }),
    ).resolves.toBe(false);
  });

  it('persists a no-aggregate initialization decision for later activations', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-plan-fast-path', 'workspace-1', 'Plan fast path');
      insert into knowledge_space_compile_runs (
        id, workspace_id, space_id, trigger, compiler_version, prompt_version,
        catalog_hash, space_job_queued_at
      ) values (
        'run-plan-fast-path', 'workspace-1', 'space-plan-fast-path', 'manual',
        'compiler-v1', 'prompt-v1', 'pending-initialization', now()
      )
    `.execute(db);
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-plan-fast-path',
      'plan-fast-path-token',
    );

    await executionRepo.initializeRun(lease, {
      aggregateRequired: false,
      targetSourcePageIds: null,
    });

    await expect(executionRepo.findLeasedRun(lease)).resolves.toEqual(
      expect.objectContaining({
        initializedAt: expect.any(Date),
        aggregateRequired: false,
      }),
    );
  });

  it('initializes 5000 unbound pages with one metadata-only INSERT SELECT', async () => {
    await sql`
      select setval('run_image_seq', 100000, true);
      insert into spaces (id, workspace_id, name)
      values ('space-large-plan', 'workspace-1', 'Large plan');
      insert into knowledge_space_compile_runs (
        id, workspace_id, space_id, trigger, compiler_version, prompt_version,
        catalog_hash, space_job_queued_at
      ) values (
        'run-large-plan', 'workspace-1', 'space-large-plan', 'manual',
        'compiler-v1', 'prompt-v1', 'pending-initialization', now()
      );
      insert into pages (id, workspace_id, space_id, updated_at)
      select 'large-page-' || ordinal, 'workspace-1', 'space-large-plan', now()
      from generate_series(0, 4999) ordinal
    `.execute(db);
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-large-plan',
      'large-plan-token',
    );
    await expect(
      executionRepo.initializeRun(lease, {
        aggregateRequired: true,
        targetSourcePageIds: null,
      }),
    ).resolves.toEqual(expect.objectContaining({ initialized: true }));

    const metadataInsert = [...executedSql]
      .reverse()
      .find((statement) =>
        statement.includes('insert into knowledge_space_compile_run_pages'),
      );
    expect(metadataInsert).toContain('from pages as page');
    expect(metadataInsert).not.toContain('text_content');
    expect(metadataInsert).not.toContain('page.content');

    const counts = await sql<{ pageCount: number; imageCount: number }>`
      select
        (select count(*)::integer from knowledge_space_compile_run_pages
         where run_id = 'run-large-plan') as "pageCount",
        (select count(*)::integer from knowledge_space_compile_run_images
         where run_id = 'run-large-plan') as "imageCount"
    `.execute(db);
    expect(counts.rows).toEqual([{ pageCount: 5_000, imageCount: 0 }]);

    executedSql.length = 0;
    await executionRepo.claimNextTextPage(lease);
    await executionRepo.bindTextPage(lease, {
      ...pagePlan('large-page-0'),
      images: [],
    });
    await executionRepo.completeTextPage(lease, {
      sourcePageId: 'large-page-0',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:large-page-0',
      status: 'succeeded',
    });
    expect(
      executedSql.some(
        (statement) =>
          statement.includes('knowledge_space_compile_run_pages') &&
          statement.includes('select "status"'),
      ),
    ).toBe(false);
    await expect(
      executionRepo.findPendingTextPages(lease),
    ).resolves.toHaveLength(1);
  });

  it('does not mix source retirement into metadata-only initialization', async () => {
    await sql`
      insert into knowledge_artifact_contributions (
        id, workspace_id, space_id, source_page_id, artifact_id
      ) values (
        'retire-contribution', 'workspace-1', 'space-retire',
        'removed-page', 'retire-artifact'
      );
      insert into knowledge_pages (id, workspace_id, space_id)
      values ('retire-artifact', 'workspace-1', 'space-retire')
    `.execute(db);
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-retire',
      'retire-token',
    );

    await executionRepo.initializeRun(lease, {
      aggregateRequired: true,
      targetSourcePageIds: null,
    });

    const evidence = await sql<{
      contributionCount: number;
      artifactStale: boolean;
    }>`
      select
        (select count(*)::integer from knowledge_artifact_contributions
          where id = 'retire-contribution') as "contributionCount",
        (select stale_at is not null from knowledge_pages
          where id = 'retire-artifact') as "artifactStale"
    `.execute(db);
    expect(evidence.rows).toEqual([
      { contributionCount: 1, artifactStale: false },
    ]);
  });

  it('requests an incremental follow-up when a text snapshot changes', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-text-changed', 'workspace-1', 'Text changed');
      insert into knowledge_space_compile_runs (
        id, workspace_id, space_id, trigger, compiler_version, prompt_version,
        catalog_hash, space_job_queued_at
      ) values (
        'run-text-changed', 'workspace-1', 'space-text-changed', 'manual',
        'compiler-v1', 'prompt-v1', 'pending-initialization', now()
      );
      insert into pages (id, workspace_id, space_id, updated_at)
      values ('changed-page', 'workspace-1', 'space-text-changed', now())
    `.execute(db);
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-text-changed',
      'text-changed-token',
    );
    await executionRepo.initializeRun(lease, {
      aggregateRequired: true,
      targetSourcePageIds: null,
    });
    await executionRepo.claimNextTextPage(lease);
    await executionRepo.bindTextPage(lease, {
      ...pagePlan('changed-page'),
      images: [],
    });

    await executionRepo.completeTextPage(lease, {
      sourcePageId: 'changed-page',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:changed-page',
      status: 'skipped',
      errorCode: 'source_changed',
    });

    const state = await sql<{ rerunRequested: boolean }>`
      select rerun_requested as "rerunRequested"
      from knowledge_space_compile_runs where id = 'run-text-changed'
    `.execute(db);
    expect(state.rows).toEqual([{ rerunRequested: true }]);
  });

  it('turns a force-run content update into one same-generation incremental follow-up', async () => {
    await sql`
      update spaces set knowledge_generation = 5 where id = 'space-force';
      update knowledge_space_compile_runs
      set mode = 'force_rebuild', knowledge_generation = 5,
          rerun_requested = true
      where id = 'run-force'
    `.execute(db);
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-force',
      'force-token',
    );

    const finished = await executionRepo.finishRun(lease, 'succeeded');

    expect(finished?.run).toMatchObject({
      mode: 'force_rebuild',
      knowledgeGeneration: 5,
      status: 'succeeded',
    });
    expect(finished?.followUp).toMatchObject({
      mode: 'incremental',
      knowledgeGeneration: 5,
      status: 'queued',
      phase: 'text',
    });
  });

  it('yields only at a checkpoint with remaining pages and preserves progress', async () => {
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-yield',
      'yield-token',
    );
    await executionRepo.initializeRun(lease, {
      aggregateRequired: true,
      targetSourcePageIds: null,
    });
    await executionRepo.claimNextTextPage(lease);
    await executionRepo.bindTextPage(lease, {
      ...pagePlan('yield-page-1'),
      images: [],
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
      recoveryKind: 'expired',
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

  it('separates queued-reservation recovery from final-failure recovery', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-recovery-race', 'workspace-1', 'Recovery race');
      insert into knowledge_space_compile_runs (
        id, workspace_id, space_id, trigger, compiler_version, prompt_version,
        catalog_hash, space_job_queued_at
      ) values (
        'run-recovery-race', 'workspace-1', 'space-recovery-race', 'manual',
        'compiler-v1', 'prompt-v1', 'pending-initialization', now()
      )
    `.execute(db);
    const liveLease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-recovery-race',
      'live-race-token',
    );

    const recovery = await executionRepo.claimRecoveryLease({
      runId: liveLease.runId,
      knowledgeGeneration: liveLease.knowledgeGeneration,
      jobPhase: liveLease.jobPhase,
      spaceJobSequence: liveLease.spaceJobSequence,
      spaceJobId: liveLease.spaceJobId,
      workerId: 'reaper-race',
      executionToken: 'recovery-race-token',
      leaseExpiredBefore: new Date(),
      executionLeaseExpiresAt: new Date(Date.now() + 180_000),
      recoveryKind: 'queued_reservation',
    });

    expect(recovery).toBeUndefined();
    await expect(
      executionRepo.heartbeatSpaceSlice(liveLease, {
        executionLeaseExpiresAt: new Date(Date.now() + 180_000),
      }),
    ).resolves.toBe(true);

    const finalFailureRecovery = await executionRepo.claimRecoveryLease({
      runId: liveLease.runId,
      knowledgeGeneration: liveLease.knowledgeGeneration,
      jobPhase: liveLease.jobPhase,
      spaceJobSequence: liveLease.spaceJobSequence,
      spaceJobId: liveLease.spaceJobId,
      workerId: 'failed-event-recovery',
      executionToken: 'final-failure-token',
      leaseExpiredBefore: new Date(),
      executionLeaseExpiresAt: new Date(Date.now() + 180_000),
      recoveryKind: 'final_failed',
    });

    expect(finalFailureRecovery?.executionToken).toBe('final-failure-token');
    await expect(
      executionRepo.heartbeatSpaceSlice(liveLease, {
        executionLeaseExpiresAt: new Date(Date.now() + 180_000),
      }),
    ).resolves.toBe(false);
  });

  it('reserves at most five images per Run and replenishes from DB state', async () => {
    const first = await compilationRepo.reserveRunImagesFairly({
      maxOutstandingPerRun: 5,
    });
    expect(first.filter((image) => image.runId === 'run-images')).toHaveLength(
      5,
    );
    const second = await compilationRepo.reserveRunImagesFairly({
      maxOutstandingPerRun: 5,
    });
    expect(second.filter((image) => image.runId === 'run-images')).toHaveLength(
      0,
    );

    const image = first.find((item) => item.runId === 'run-images')!;
    await compilationRepo.claimRunImage({
      ...image,
      processingExpiresAt: new Date(Date.now() + 210_000),
    });
    await expect(
      compilationRepo.requeueMissingRunImage({
        ...image,
        observedStatus: 'queued',
        processingExpiredBefore: new Date(),
        queuedDispatchedBefore: new Date(),
      }),
    ).resolves.toBe(false);
    const completedImage = await compilationRepo.completeRunImage({
      ...image,
      status: 'succeeded',
      extractionId: 'extraction-1',
    });
    expect(completedImage?.imageStatus).toBe('queued');
    const replenished = await compilationRepo.reserveRunImagesFairly({
      maxOutstandingPerRun: 5,
    });
    expect(
      replenished.filter((item) => item.runId === 'run-images'),
    ).toHaveLength(1);
  });

  it('publishes merge pages in snapshot order and advances the final barrier once', async () => {
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-merge',
      'merge-token',
    );
    const pages = await executionRepo.findPendingMergePages(lease);
    expect(pages.map((page) => page.sourcePageId)).toEqual(['merge-page-1']);
    expect(pages[0].images.map((image) => image.attachmentId)).toEqual([
      'merge-attachment-0',
      'merge-attachment-1',
    ]);

    await db.transaction().execute((trx) =>
      executionRepo.completeMergePagePublicationInTransaction(
        lease,
        {
          sourcePageId: 'merge-page-1',
          sourceVersion: 'v1',
          sourceContentHash: 'sha256:merge-page-1',
          effectiveKnowledgeHash: 'sha256:effective-1',
        },
        trx as never,
      ),
    );
    const afterFirst = await executionRepo.findLeasedRun(lease);
    expect(afterFirst?.phase).toBe('image_merge');
    await expect(executionRepo.findPendingMergePages(lease)).resolves.toEqual([
      expect.objectContaining({ sourcePageId: 'merge-page-2' }),
    ]);
    await expect(
      db.transaction().execute((trx) =>
        executionRepo.completeMergePagePublicationInTransaction(
          lease,
          {
            sourcePageId: 'merge-page-1',
            sourceVersion: 'v1',
            sourceContentHash: 'sha256:merge-page-1',
            effectiveKnowledgeHash: 'sha256:duplicate',
          },
          trx as never,
        ),
      ),
    ).resolves.toBe(false);

    await db.transaction().execute((trx) =>
      executionRepo.completeMergePagePublicationInTransaction(
        lease,
        {
          sourcePageId: 'merge-page-2',
          sourceVersion: 'v1',
          sourceContentHash: 'sha256:merge-page-2',
          effectiveKnowledgeHash: 'sha256:effective-2',
        },
        trx as never,
      ),
    );
    const afterSecond = await executionRepo.findLeasedRun(lease);
    expect(afterSecond?.phase).toBe('finalizing');
    await expect(executionRepo.advanceMergeBarrier(lease)).resolves.toEqual({
      barrierComplete: true,
    });
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
    create table pages (
      id varchar primary key,
      workspace_id varchar not null,
      space_id varchar not null,
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
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
      target_source_page_ids jsonb,
      aggregate_required boolean not null default true,
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
      binding_status varchar not null default 'bound',
      discovered_source_version timestamptz,
      expected_source_version varchar,
      expected_source_content_hash varchar,
      expected_image_count integer default 0,
      bound_at timestamptz default now(),
      quality_status varchar not null default 'normal',
      reused boolean not null default false,
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
      job_id varchar,
      dispatched_at timestamptz,
      processing_expires_at timestamptz,
      extraction_id varchar,
      attempt_count integer not null default 0,
      redis_recovery_count integer not null default 0,
      failure_class varchar,
      error_code varchar,
      error_message varchar,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index uq_run_image_source_attachment
      on knowledge_space_compile_run_images
      (run_id, source_page_id, attachment_id);
    create unique index uq_run_image_page_ordinal
      on knowledge_space_compile_run_images (run_page_id, image_ordinal);
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
      ('space-recovery', 'workspace-1', 'Recovery'),
      ('space-retire', 'workspace-1', 'Retire'),
      ('space-force', 'workspace-1', 'Force'),
      ('space-images', 'workspace-1', 'Images'),
      ('space-merge', 'workspace-1', 'Merge');
    insert into pages (id, workspace_id, space_id) values
      ('page-1', 'workspace-1', 'space-finish'),
      ('yield-page-1', 'workspace-1', 'space-yield'),
      ('yield-page-2', 'workspace-1', 'space-yield');
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
       'prompt-v1', 'pending-initialization', now()),
      ('run-retire', 'workspace-1', 'space-retire', 'manual', 'compiler-v1',
       'prompt-v1', 'pending-initialization', now()),
      ('run-force', 'workspace-1', 'space-force', 'manual', 'compiler-v1',
       'prompt-v1', 'pending-initialization', now()),
      ('run-images', 'workspace-1', 'space-images', 'manual', 'compiler-v1',
       'prompt-v1', 'images', now()),
      ('run-merge', 'workspace-1', 'space-merge', 'manual', 'compiler-v1',
       'prompt-v1', 'merge', now());
    update knowledge_space_compile_runs
      set phase='images', status='compiling', initialized_at=now(),
          expected_page_count=1
      where id='run-images';
    update knowledge_space_compile_runs
      set phase='image_merge', status='queued', initialized_at=now(),
          expected_page_count=2
      where id='run-merge';
    insert into knowledge_space_compile_run_pages (
      id, run_id, workspace_id, space_id, source_page_id,
      expected_source_version, expected_source_content_hash,
      expected_image_count, image_status, merge_status, status
    ) values (
      'run-page-images', 'run-images', 'workspace-1', 'space-images',
      'page-images', 'v1', 'sha256:page-images', 6,
      'pending', 'waiting_images', 'succeeded'
    );
    insert into knowledge_space_compile_run_images (
      id, run_id, run_page_id, workspace_id, space_id, source_page_id,
      attachment_id, image_ordinal, file_name, mime_type,
      expected_attachment_version
    )
    select 'run-image-' || ordinal, 'run-images', 'run-page-images',
           'workspace-1', 'space-images', 'page-images',
           'attachment-' || ordinal, ordinal, ordinal || '.png', 'image/png',
           now()
    from generate_series(0, 5) ordinal
    ;
    insert into knowledge_space_compile_run_pages (
      id, run_id, workspace_id, space_id, source_page_id,
      expected_source_version, expected_source_content_hash,
      expected_image_count, succeeded_image_count,
      image_status, merge_status, status, created_at
    ) values
      ('run-page-merge-1', 'run-merge', 'workspace-1', 'space-merge',
       'merge-page-1', 'v1', 'sha256:merge-page-1', 2, 2,
       'succeeded', 'pending', 'succeeded', now() - interval '1 second'),
      ('run-page-merge-2', 'run-merge', 'workspace-1', 'space-merge',
       'merge-page-2', 'v1', 'sha256:merge-page-2', 1, 1,
       'succeeded', 'pending', 'succeeded', now());
    insert into knowledge_space_compile_run_images (
      id, run_id, run_page_id, workspace_id, space_id, source_page_id,
      attachment_id, image_ordinal, file_name, mime_type,
      expected_attachment_version, status
    ) values
      ('run-image-merge-0', 'run-merge', 'run-page-merge-1',
       'workspace-1', 'space-merge', 'merge-page-1', 'merge-attachment-0',
       0, '0.png', 'image/png', now(), 'succeeded'),
      ('run-image-merge-1', 'run-merge', 'run-page-merge-1',
       'workspace-1', 'space-merge', 'merge-page-1', 'merge-attachment-1',
       1, '1.png', 'image/png', now(), 'succeeded'),
      ('run-image-merge-2', 'run-merge', 'run-page-merge-2',
       'workspace-1', 'space-merge', 'merge-page-2', 'merge-attachment-2',
       0, '2.png', 'image/png', now(), 'succeeded')
  `.execute(db);
}
