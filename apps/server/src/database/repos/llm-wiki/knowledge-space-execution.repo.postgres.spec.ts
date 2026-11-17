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
    executedSql.length = 0;
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
      compilationRepo.reserveNextSpaceJob({ runId: 'run-text' }),
      compilationRepo.reserveNextSpaceJob({ runId: 'run-text' }),
    ]);
    const reserved = reservations.find(Boolean)!;
    expect(reservations.filter(Boolean)).toHaveLength(1);
    expect(reserved.spaceJobSequence).toBe(1);

    const lease = await executionRepo.claimSpaceLease({
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
      executionRepo.heartbeatSpaceLease(lease!, {
        executionLeaseExpiresAt: new Date(Date.now() + 180_000),
      }),
    ).resolves.toBe(true);
    await expect(
      executionRepo.heartbeatSpaceLease(
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
      targetSourcePageIds: null,
    });
    expect(initialized?.initialized).toBe(true);
    await expect(
      executionRepo.initializeRun(
        { ...lease, executionToken: 'old-token' },
        {
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
          follow_up_target_source_page_ids = '["page-1", "page-2"]'::jsonb
      where id = 'run-finish'
    `.execute(db);

    const finalize = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-finish',
      'finish-finalize-token',
    );
    const finished = await executionRepo.finishRun(finalize, 'succeeded');
    expect(finished?.run.status).toBe('succeeded');
    expect(finished?.followUp).toEqual(
      expect.objectContaining({
        mode: 'incremental',
        knowledgeGeneration: 0,
        targetSourcePageIds: ['page-1', 'page-2'],
      }),
    );
    await expect(
      executionRepo.heartbeatSpaceLease(lease, {
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
        space_job_queued_at
      ) values (
        'run-plan-fast-path', 'workspace-1', 'space-plan-fast-path', 'manual',
        'compiler-v1', 'prompt-v1', now()
      )
    `.execute(db);
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-plan-fast-path',
      'plan-fast-path-token',
    );

    await executionRepo.initializeRun(lease, {
      targetSourcePageIds: null,
    });

    await expect(executionRepo.findLeasedRun(lease)).resolves.toEqual(
      expect.objectContaining({
        initializedAt: expect.any(Date),
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
        space_job_queued_at
      ) values (
        'run-large-plan', 'workspace-1', 'space-large-plan', 'manual',
        'compiler-v1', 'prompt-v1', now()
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
        targetSourcePageIds: null,
      }),
    ).resolves.toEqual(expect.objectContaining({ initialized: true }));

    const metadataInsert = [...executedSql]
      .reverse()
      .map((statement) => statement.toLowerCase())
      .find(
        (statement) =>
          statement.includes('insert into knowledge_space_compile_run_pages') &&
          statement.includes('select'),
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
        space_job_queued_at
      ) values (
        'run-text-changed', 'workspace-1', 'space-text-changed', 'manual',
        'compiler-v1', 'prompt-v1', now()
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

    const state = await sql<{
      rerunRequested: boolean;
      targetSourcePageIds: string[] | null;
      followUpTargetSourcePageIds: string[] | null;
    }>`
      select rerun_requested as "rerunRequested",
             target_source_page_ids as "targetSourcePageIds",
             follow_up_target_source_page_ids as "followUpTargetSourcePageIds"
      from knowledge_space_compile_runs where id = 'run-text-changed'
    `.execute(db);
    expect(state.rows).toEqual([
      {
        rerunRequested: true,
        targetSourcePageIds: null,
        followUpTargetSourcePageIds: ['changed-page'],
      },
    ]);

    await executionRepo.advanceTextBarrier(lease);
    const finalize = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-text-changed',
      'changed-finalize-token',
    );
    const finished = await executionRepo.finishRun(finalize, 'succeeded');
    expect(finished?.followUp).toMatchObject({
      trigger: 'follow_up',
      targetSourcePageIds: ['changed-page'],
    });
  });

  it('unions every page changed mid-run into the follow-up scope', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-multi-changed', 'workspace-1', 'Multi changed');
      insert into knowledge_space_compile_runs (
        id, workspace_id, space_id, trigger, compiler_version, prompt_version,
        space_job_queued_at
      ) values (
        'run-multi-changed', 'workspace-1', 'space-multi-changed', 'manual',
        'compiler-v1', 'prompt-v1', now()
      );
      insert into pages (id, workspace_id, space_id, updated_at)
      values
        ('multi-page-a', 'workspace-1', 'space-multi-changed', now()),
        ('multi-page-b', 'workspace-1', 'space-multi-changed', now())
    `.execute(db);
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-multi-changed',
      'multi-changed-token',
    );
    await executionRepo.initializeRun(lease, {
      targetSourcePageIds: null,
    });

    for (const sourcePageId of ['multi-page-a', 'multi-page-b']) {
      await executionRepo.claimNextTextPage(lease);
      await executionRepo.bindTextPage(lease, {
        ...pagePlan(sourcePageId),
        images: [],
      });
      await executionRepo.completeTextPage(lease, {
        sourcePageId,
        sourceVersion: 'v1',
        sourceContentHash: `sha256:${sourcePageId}`,
        status: 'skipped',
        errorCode: 'source_changed',
      });
    }

    const state = await sql<{
      targetSourcePageIds: string[] | null;
      followUpTargetSourcePageIds: string[] | null;
    }>`
      select target_source_page_ids as "targetSourcePageIds",
             follow_up_target_source_page_ids as "followUpTargetSourcePageIds"
      from knowledge_space_compile_runs where id = 'run-multi-changed'
    `.execute(db);
    expect(state.rows[0]?.targetSourcePageIds).toBeNull();
    expect(state.rows[0]?.followUpTargetSourcePageIds?.slice().sort()).toEqual([
      'multi-page-a',
      'multi-page-b',
    ]);
  });

  it('keeps a multi-page current scope immutable when one page changes', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-scoped-changed', 'workspace-1', 'Scoped changed');
      insert into knowledge_space_compile_runs (
        id, workspace_id, space_id, trigger, compiler_version, prompt_version,
        target_source_page_ids, space_job_queued_at
      ) values (
        'run-scoped-changed', 'workspace-1', 'space-scoped-changed', 'page_retry',
        'compiler-v1', 'prompt-v1',
        '["scoped-page-a", "scoped-page-b"]'::jsonb, now()
      );
      insert into pages (id, workspace_id, space_id, updated_at)
      values
        ('scoped-page-a', 'workspace-1', 'space-scoped-changed', now()),
        ('scoped-page-b', 'workspace-1', 'space-scoped-changed', now())
    `.execute(db);
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-scoped-changed',
      'scoped-changed-token',
    );
    await executionRepo.initializeRun(lease, {
      targetSourcePageIds: ['scoped-page-a', 'scoped-page-b'],
    });
    await executionRepo.claimNextTextPage(lease);
    await executionRepo.bindTextPage(lease, {
      ...pagePlan('scoped-page-a'),
      images: [],
    });
    await executionRepo.completeTextPage(lease, {
      sourcePageId: 'scoped-page-a',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:scoped-page-a',
      status: 'skipped',
      errorCode: 'source_changed',
    });

    const state = await sql<{
      targetSourcePageIds: string[];
      followUpTargetSourcePageIds: string[];
    }>`
      select target_source_page_ids as "targetSourcePageIds",
             follow_up_target_source_page_ids as "followUpTargetSourcePageIds"
      from knowledge_space_compile_runs where id = 'run-scoped-changed'
    `.execute(db);
    expect(state.rows).toEqual([
      {
        targetSourcePageIds: ['scoped-page-a', 'scoped-page-b'],
        followUpTargetSourcePageIds: ['scoped-page-a'],
      },
    ]);
  });

  it('bounds image snapshot follow-up without changing the current scope', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-image-changed', 'workspace-1', 'Image changed');
      insert into knowledge_space_compile_runs (
        id, workspace_id, space_id, trigger, compiler_version, prompt_version,
        target_source_page_ids, phase, initialized_at,
        expected_page_count, succeeded_page_count, space_job_queued_at
      ) values (
        'run-image-changed', 'workspace-1', 'space-image-changed', 'page_retry',
        'compiler-v1', 'prompt-v1',
        '["image-page-a", "image-page-b"]'::jsonb, 'image_merge', now(),
        1, 1, now()
      );
      insert into knowledge_space_compile_run_pages (
        id, run_id, workspace_id, space_id, source_page_id, binding_status,
        expected_source_version, expected_source_content_hash, status,
        image_status, merge_status, merge_attempt_count
      ) values (
        'run-page-image-changed', 'run-image-changed', 'workspace-1',
        'space-image-changed', 'image-page-a', 'bound', 'v1',
        'sha256:image-page-a', 'succeeded', 'succeeded', 'pending', 0
      )
    `.execute(db);
    const fence = await claimMergeForRun(
      db,
      executionRepo,
      'run-image-changed',
    );
    await executionRepo.finishPageMerge(fence, {
      status: 'failed',
      retryable: false,
      errorCode: 'image_snapshot_changed',
    });

    const state = await sql<{
      targetSourcePageIds: string[];
      followUpTargetSourcePageIds: string[];
    }>`
      select target_source_page_ids as "targetSourcePageIds",
             follow_up_target_source_page_ids as "followUpTargetSourcePageIds"
      from knowledge_space_compile_runs where id = 'run-image-changed'
    `.execute(db);
    expect(state.rows).toEqual([
      {
        targetSourcePageIds: ['image-page-a', 'image-page-b'],
        followUpTargetSourcePageIds: ['image-page-a'],
      },
    ]);
    const finalize = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-image-changed',
      'image-changed-finalize',
    );
    const finished = await executionRepo.finishRun(finalize, 'partial');
    expect(finished?.followUp).toMatchObject({
      trigger: 'follow_up',
      targetSourcePageIds: ['image-page-a'],
    });
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

    await executionRepo.advanceTextBarrier(lease);
    const finalize = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-force',
      'force-finalize-token',
    );
    const finished = await executionRepo.finishRun(finalize, 'succeeded');

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
      executionRepo.yieldSpaceLease(lease, { reason: 'page_limit' }),
    ).resolves.toBe(true);
    const continuation = await compilationRepo.reserveNextSpaceJob({
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
    await expect(executionRepo.requeueMissingSpaceJob(recovery!)).resolves.toBe(
      true,
    );
    const next = await compilationRepo.reserveNextSpaceJob({
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
        space_job_queued_at
      ) values (
        'run-recovery-race', 'workspace-1', 'space-recovery-race', 'manual',
        'compiler-v1', 'prompt-v1', now()
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
      executionRepo.heartbeatSpaceLease(liveLease, {
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
      executionRepo.heartbeatSpaceLease(liveLease, {
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
      status: 'failed',
      failureClass: 'permanent',
      errorCode: 'image_extraction_failed',
    });
    expect(completedImage?.imageStatus).toBe('queued');
    const replenished = await compilationRepo.reserveRunImagesFairly({
      maxOutstandingPerRun: 5,
    });
    expect(
      replenished.filter((item) => item.runId === 'run-images'),
    ).toHaveLength(1);

    const remainingImages = [
      ...first.filter(
        (item) =>
          item.runId === 'run-images' && item.runImageId !== image.runImageId,
      ),
      ...replenished.filter((item) => item.runId === 'run-images'),
    ];
    let finalCompletion:
      | Awaited<ReturnType<KnowledgeSpaceCompilationRepo['completeRunImage']>>
      | undefined;
    for (const remainingImage of remainingImages) {
      finalCompletion = await compilationRepo.completeRunImage({
        ...remainingImage,
        status: 'failed',
        failureClass: 'permanent',
        errorCode: 'image_extraction_failed',
      });
    }

    expect(finalCompletion).toEqual(
      expect.objectContaining({
        imageStatus: 'partial',
        succeeded: 0,
        failed: 6,
        barrierAdvanced: true,
      }),
    );
    await expect(pageColumns(db, 'run-page-images')).resolves.toEqual(
      expect.objectContaining({
        mergeStatus: 'pending',
        qualityStatus: 'partial_image',
      }),
    );
    const advancedRun = await sql<{ phase: string; status: string }>`
      select phase, status
        from knowledge_space_compile_runs
       where id = 'run-images'
    `.execute(db);
    expect(advancedRun.rows[0]).toEqual({
      phase: 'image_merge',
      status: 'compiling',
    });
  });

  it('publishes independent merge pages in snapshot order and queues one Finalize', async () => {
    const first = await claimMergeForRun(db, executionRepo, 'run-merge');
    expect(first.sourcePageId).toBe('merge-page-1');
    expect(first.images.map((image) => image.attachmentId)).toEqual([
      'merge-attachment-0',
      'merge-attachment-1',
    ]);
    await db
      .transaction()
      .execute((trx) =>
        executionRepo.completePageMerge(
          first,
          { effectiveKnowledgeHash: 'effective-1' },
          trx as never,
        ),
      );
    const second = await claimMergeForRun(db, executionRepo, 'run-merge');
    expect(second.sourcePageId).toBe('merge-page-2');
    await expect(
      db
        .transaction()
        .execute((trx) =>
          executionRepo.completePageMerge(
            first,
            { effectiveKnowledgeHash: 'duplicate' },
            trx as never,
          ),
        ),
    ).resolves.toBe(false);
    await db
      .transaction()
      .execute((trx) =>
        executionRepo.completePageMerge(
          second,
          { effectiveKnowledgeHash: 'effective-2' },
          trx as never,
        ),
      );
    const finalize = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-merge',
      'finalize-merge',
    );
    expect(finalize.jobPhase).toBe('finalize');
    await expect(
      compilationRepo.reserveNextSpaceJob({ runId: 'run-merge' }),
    ).resolves.toBeUndefined();
  });

  it('schedules image work for a text-phase Run sitting between leases', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-overlap', 'workspace-1', 'Overlap');
      insert into knowledge_space_compile_runs (
        id, workspace_id, space_id, trigger, compiler_version, prompt_version,
        space_job_queued_at, phase, status, initialized_at,
        expected_page_count
      ) values (
        'run-overlap', 'workspace-1', 'space-overlap', 'manual', 'compiler-v1',
        'prompt-v1', now(), 'text', 'queued', now(), 2
      );
      insert into knowledge_space_compile_run_pages (
        id, run_id, workspace_id, space_id, source_page_id,
        expected_source_version, expected_source_content_hash,
        expected_image_count, image_status, merge_status, status
      ) values
        ('run-page-overlap-1', 'run-overlap', 'workspace-1', 'space-overlap',
         'overlap-page-1', 'v1', 'sha256:overlap-page-1', 2,
         'pending', 'waiting_images', 'succeeded'),
        ('run-page-overlap-2', 'run-overlap', 'workspace-1', 'space-overlap',
         'overlap-page-2', 'v1', 'sha256:overlap-page-2', 0,
         'not_required', 'not_required', 'pending');
      insert into knowledge_space_compile_run_images (
        id, run_id, run_page_id, workspace_id, space_id, source_page_id,
        attachment_id, image_ordinal, file_name, mime_type,
        expected_attachment_version
      ) values
        ('run-image-overlap-0', 'run-overlap', 'run-page-overlap-1',
         'workspace-1', 'space-overlap', 'overlap-page-1', 'overlap-attach-0',
         0, '0.png', 'image/png', now()),
        ('run-image-overlap-1', 'run-overlap', 'run-page-overlap-1',
         'workspace-1', 'space-overlap', 'overlap-page-1', 'overlap-attach-1',
         1, '1.png', 'image/png', now())
    `.execute(db);

    const reserved = await compilationRepo.reserveRunImagesFairly({
      maxOutstandingPerRun: 5,
    });
    expect(
      reserved.filter((image) => image.runId === 'run-overlap'),
    ).toHaveLength(2);

    const undispatched = await compilationRepo.findUndispatchedRunImages();
    expect(
      undispatched.filter((image) => image.runId === 'run-overlap'),
    ).toHaveLength(2);

    expect(reserved.filter((image) => image.runId === 'run-text')).toHaveLength(
      0,
    );

    await sql`
      update knowledge_space_compile_run_images
         set dispatched_at = now() - interval '1 hour'
       where run_id = 'run-overlap'
    `.execute(db);
    const stranded = await compilationRepo.findRunImageRecoveryCandidates({
      processingExpiredBefore: new Date(),
      queuedDispatchedBefore: new Date(Date.now() - 60_000),
    });
    expect(
      stranded.filter((image) => image.runId === 'run-overlap'),
    ).toHaveLength(2);
  });

  it('spends one attempt per text claim and one per merge claim independently', async () => {
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-claim',
      'claim-token',
    );
    const claimed = await executionRepo.claimNextTextPage(lease);
    expect(claimed).toEqual(
      expect.objectContaining({
        sourcePageId: 'claim-page',
        attemptCount: 2,
      }),
    );
    await expect(pageColumns(db, 'run-page-claim')).resolves.toEqual(
      expect.objectContaining({ attemptCount: 2, mergeAttemptCount: 0 }),
    );
  });

  it('hands retryable text failures back once and recounts from the page rows', async () => {
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-settle',
      'settle-token',
    );

    const settlement = await executionRepo.advanceTextBarrier(lease);
    expect(settlement).toEqual(
      expect.objectContaining({ barrierComplete: false, reclaimed: true }),
    );
    await expect(pageColumns(db, 'run-page-settle-retry')).resolves.toEqual(
      expect.objectContaining({
        status: 'pending',
        errorCode: null,
        finishedAt: null,
        attemptCount: 1,
      }),
    );
    const run = await executionRepo.findLeasedRun(lease);
    expect(run).toEqual(
      expect.objectContaining({
        phase: 'text',
        succeededPageCount: 1,
        failedPageCount: 0,
        skippedPageCount: 0,
      }),
    );
    expect(
      run!.succeededPageCount + run!.failedPageCount + run!.skippedPageCount,
    ).toBeLessThanOrEqual(run!.expectedPageCount);
  });

  it('stops settling a text page once its attempts are spent', async () => {
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-spent',
      'spent-token',
    );

    const barrier = await executionRepo.advanceTextBarrier(lease);
    expect(barrier).toEqual(
      expect.objectContaining({ barrierComplete: true, reclaimed: false }),
    );
    await expect(pageColumns(db, 'run-page-spent')).resolves.toEqual(
      expect.objectContaining({ status: 'failed', attemptCount: 2 }),
    );
  });

  it('records a permanent text failure at the budget ceiling', async () => {
    const lease = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-perm',
      'perm-token',
    );

    await executionRepo.completeTextPage(lease, {
      sourcePageId: 'perm-page',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:perm-page',
      status: 'failed',
      retryable: false,
      errorCode: 'input_too_large',
    });

    await expect(pageColumns(db, 'run-page-perm')).resolves.toEqual(
      expect.objectContaining({ status: 'failed', attemptCount: 2 }),
    );
    await expect(executionRepo.advanceTextBarrier(lease)).resolves.toEqual(
      expect.objectContaining({ reclaimed: false }),
    );
  });

  it('keeps the single Merge slot through all three attempts and reports partial', async () => {
    const first = await claimMergeForRun(db, executionRepo, 'run-msettle');
    await db
      .transaction()
      .execute((trx) =>
        executionRepo.completePageMerge(
          first,
          { effectiveKnowledgeHash: 'effective-ok' },
          trx as never,
        ),
      );
    await sql`update knowledge_space_compile_run_pages set merge_attempt_count = 0 where id = 'run-page-msettle-retry'`.execute(
      db,
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
      const fence = await claimMergeForRun(db, executionRepo, 'run-msettle');
      expect(fence.mergeAttemptCount).toBe(attempt);
      expect(
        await executionRepo.finishPageMerge(fence, {
          status: 'failed',
          retryable: true,
          errorCode: 'provider_unavailable',
        }),
      ).toEqual({ terminal: attempt === 3 });
      expect((await pageColumns(db, fence.runPageId)).mergeStatus).toBe(
        attempt === 3 ? 'failed' : 'queued',
      );
      if (attempt < 3)
        expect(
          (await executionRepo.reservePageMergesFairly()).filter(
            (item) => item.runId === 'run-msettle',
          ),
        ).toHaveLength(0);
    }
    const finalize = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-msettle',
      'finalize-partial',
    );
    expect(
      (await executionRepo.finishRun(finalize, 'succeeded'))?.run.status,
    ).toBe('partial');
  });

  it('ends a permanent merge failure immediately and derives partial in Finalize', async () => {
    const fence = await claimMergeForRun(db, executionRepo, 'run-mspent');
    expect(
      await executionRepo.finishPageMerge(fence, {
        status: 'failed',
        retryable: false,
        errorCode: 'input_too_large',
      }),
    ).toEqual({ terminal: true });
    expect(await pageColumns(db, fence.runPageId)).toMatchObject({
      mergeStatus: 'failed',
      mergeAttemptCount: 3,
      qualityStatus: 'partial_image',
    });
    const finalize = await claimedLease(
      compilationRepo,
      executionRepo,
      'run-mspent',
      'finalize-permanent',
    );
    expect(
      (await executionRepo.finishRun(finalize, 'succeeded'))?.run.status,
    ).toBe('partial');
  });
});

type PageColumns = {
  status: string;
  mergeStatus: string;
  attemptCount: number;
  mergeAttemptCount: number;
  qualityStatus: string;
  errorCode: string | null;
  finishedAt: Date | null;
};

async function pageColumns(
  db: Kysely<unknown>,
  id: string,
): Promise<PageColumns> {
  const result = await sql<PageColumns>`
    select status, merge_status, attempt_count, merge_attempt_count,
           quality_status, error_code, finished_at
      from knowledge_space_compile_run_pages
     where id = ${id}
  `.execute(db);
  return result.rows[0];
}

async function claimMergeForRun(
  db: Kysely<unknown>,
  repo: KnowledgeSpaceExecutionRepo,
  runId: string,
) {
  await repo.reservePageMergesFairly();
  const slot = await sql<{
    runPageId: string;
    mergeJobId: string;
    knowledgeGeneration: number;
  }>`
    select page.id as "runPageId", page.merge_job_id as "mergeJobId", run.knowledge_generation as "knowledgeGeneration"
    from knowledge_space_compile_run_pages page join knowledge_space_compile_runs run on run.id = page.run_id
    where page.run_id = ${runId} and page.merge_status = 'queued'
  `.execute(db);
  if (!slot.rows[0]) throw new Error(`No Merge slot for ${runId}`);
  const claimed = await repo.claimPageMerge({
    ...slot.rows[0],
    runId,
    workerId: 'merge-test',
    processingExpiresAt: new Date(Date.now() + 180_000),
  });
  if (!claimed) throw new Error(`Cannot claim Merge for ${runId}`);
  return claimed;
}

async function claimedLease(
  compilationRepo: KnowledgeSpaceCompilationRepo,
  executionRepo: KnowledgeSpaceExecutionRepo,
  runId: string,
  token: string,
): Promise<SpaceExecutionLease> {
  const reservation = await compilationRepo.reserveNextSpaceJob({ runId });
  return (await executionRepo.claimSpaceLease({
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
      target_source_page_ids jsonb,
      follow_up_target_source_page_ids jsonb,
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
      rerun_requested boolean not null default false,
      constraint chk_knowledge_space_compile_runs_counts check (
        expected_page_count >= 0 and succeeded_page_count >= 0 and
        failed_page_count >= 0 and skipped_page_count >= 0 and
        succeeded_page_count + failed_page_count + skipped_page_count
          <= expected_page_count
      )
    );
    create unique index uq_active_space_run
      on knowledge_space_compile_runs (workspace_id, space_id)
      where status in ('queued','compiling','aggregating');
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
      merge_job_id varchar,
      merge_execution_token varchar,
      merge_dispatched_at timestamptz,
      merge_processing_expires_at timestamptz,
      merge_worker_id varchar,
      merge_heartbeat_at timestamptz,
      merge_failure_class varchar,
      merge_redis_recovery_count integer not null default 0,
      target_effective_knowledge_hash varchar,
      merged_effective_knowledge_hash varchar,
      status varchar not null default 'pending',
      attempt_count integer not null default 0,
      merge_attempt_count integer not null default 0,
      error_code varchar,
      error_message varchar,
      queued_at timestamptz,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (run_id, source_page_id),
      constraint chk_knowledge_space_compile_run_pages_attempt_count
        check (attempt_count >= 0 and merge_attempt_count >= 0)
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
    create table knowledge_compilation_attempts (
      id varchar primary key default ('attempt-' || nextval('run_seq')),
      workspace_id varchar not null,
      space_id varchar not null,
      source_page_id varchar,
      compile_task_id varchar not null,
      compiler_version varchar not null default 'compiler-v1',
      prompt_version varchar not null default 'prompt-v1',
      source_content_hash varchar,
      status varchar not null default 'running',
      error_code varchar,
      error_message varchar,
      started_at timestamptz not null default now(),
      finished_at timestamptz,
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
      ('space-recovery', 'workspace-1', 'Recovery'),
      ('space-retire', 'workspace-1', 'Retire'),
      ('space-force', 'workspace-1', 'Force'),
      ('space-images', 'workspace-1', 'Images'),
      ('space-merge', 'workspace-1', 'Merge'),
      ('space-claim', 'workspace-1', 'Claim'),
      ('space-settle', 'workspace-1', 'Settle'),
      ('space-spent', 'workspace-1', 'Spent'),
      ('space-perm', 'workspace-1', 'Permanent'),
      ('space-msettle', 'workspace-1', 'MergeSettle'),
      ('space-mspent', 'workspace-1', 'MergeSpent');
    insert into pages (id, workspace_id, space_id) values
      ('page-1', 'workspace-1', 'space-finish'),
      ('yield-page-1', 'workspace-1', 'space-yield'),
      ('yield-page-2', 'workspace-1', 'space-yield');
    insert into knowledge_space_compile_runs (
      id, workspace_id, space_id, trigger, compiler_version, prompt_version,
      space_job_queued_at
    ) values
      ('run-text', 'workspace-1', 'space-text', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-finish', 'workspace-1', 'space-finish', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-yield', 'workspace-1', 'space-yield', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-recovery', 'workspace-1', 'space-recovery', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-retire', 'workspace-1', 'space-retire', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-force', 'workspace-1', 'space-force', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-images', 'workspace-1', 'space-images', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-merge', 'workspace-1', 'space-merge', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-claim', 'workspace-1', 'space-claim', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-settle', 'workspace-1', 'space-settle', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-spent', 'workspace-1', 'space-spent', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-perm', 'workspace-1', 'space-perm', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-msettle', 'workspace-1', 'space-msettle', 'manual', 'compiler-v1',
       'prompt-v1', now()),
      ('run-mspent', 'workspace-1', 'space-mspent', 'manual', 'compiler-v1',
       'prompt-v1', now());
    update knowledge_space_compile_runs
      set phase='images', status='compiling', initialized_at=now(),
          expected_page_count=1, succeeded_page_count=1
      where id='run-images';
    update knowledge_space_compile_runs
      set phase='image_merge', status='compiling', initialized_at=now(),
          expected_page_count=2, succeeded_page_count=2
      where id='run-merge';
    -- Text settlement: barrier is satisfied (1 succeeded + 1 failed = 2) and
    -- the failed page still has budget, so advanceTextBarrier must hand it back
    -- instead of closing the phase. Counters are deliberately left drifted
    -- (failed=2 against one failed row) to prove the recount overwrites rather
    -- than accumulates.
    update knowledge_space_compile_runs
      set phase='text', status='compiling', initialized_at=now(),
          expected_page_count=1
      where id='run-claim';
    update knowledge_space_compile_runs
      set phase='text', status='compiling', initialized_at=now(),
          expected_page_count=2, succeeded_page_count=0, failed_page_count=2
      where id='run-settle';
    update knowledge_space_compile_runs
      set phase='text', status='compiling', initialized_at=now(),
          expected_page_count=1, failed_page_count=1
      where id='run-spent';
    update knowledge_space_compile_runs
      set phase='text', status='compiling', initialized_at=now(),
          expected_page_count=1
      where id='run-perm';
    update knowledge_space_compile_runs
      set phase='image_merge', status='compiling', initialized_at=now(),
          expected_page_count=2, succeeded_page_count=2
      where id='run-msettle';
    update knowledge_space_compile_runs
      set phase='image_merge', status='compiling', initialized_at=now(),
          expected_page_count=1, succeeded_page_count=1
      where id='run-mspent';
    insert into knowledge_space_compile_run_pages (
      id, run_id, workspace_id, space_id, source_page_id,
      expected_source_version, expected_source_content_hash,
      status, attempt_count, quality_status, created_at
    ) values
      -- Already settled once (attempt_count = 1) and handed back to pending,
      -- so the next claim is the settlement pass and must land on 2.
      ('run-page-claim', 'run-claim', 'workspace-1', 'space-claim',
       'claim-page', 'v1', 'sha256:claim-page',
       'pending', 1, 'normal', now()),
      ('run-page-settle-ok', 'run-settle', 'workspace-1', 'space-settle',
       'settle-page-ok', 'v1', 'sha256:settle-page-ok',
       'succeeded', 1, 'normal', now() - interval '2 second'),
      ('run-page-settle-retry', 'run-settle', 'workspace-1', 'space-settle',
       'settle-page-retry', 'v1', 'sha256:settle-page-retry',
       'failed', 1, 'normal', now() - interval '1 second'),
      ('run-page-spent', 'run-spent', 'workspace-1', 'space-spent',
       'spent-page', 'v1', 'sha256:spent-page',
       'failed', 2, 'normal', now()),
      ('run-page-perm', 'run-perm', 'workspace-1', 'space-perm',
       'perm-page', 'v1', 'sha256:perm-page',
       'pending', 1, 'normal', now());
    -- Merge failure is terminal on its first completed attempt and upgrades
    -- the page quality status to partial_image.
    insert into knowledge_space_compile_run_pages (
      id, run_id, workspace_id, space_id, source_page_id,
      expected_source_version, expected_source_content_hash,
      expected_image_count, succeeded_image_count,
      image_status, merge_status, status,
      merge_attempt_count, quality_status, created_at
    ) values
      ('run-page-msettle-ok', 'run-msettle', 'workspace-1', 'space-msettle',
       'msettle-page-ok', 'v1', 'sha256:msettle-page-ok', 1, 1,
       'succeeded', 'pending', 'succeeded', 0, 'normal',
       now() - interval '2 second'),
      ('run-page-msettle-retry', 'run-msettle', 'workspace-1', 'space-msettle',
       'msettle-page-retry', 'v1', 'sha256:msettle-page-retry', 1, 1,
       'succeeded', 'pending', 'succeeded', 1, 'degraded',
       now() - interval '1 second'),
      ('run-page-mspent', 'run-mspent', 'workspace-1', 'space-mspent',
       'mspent-page', 'v1', 'sha256:mspent-page', 1, 1,
       'succeeded', 'pending', 'succeeded', 1, 'degraded', now());
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
