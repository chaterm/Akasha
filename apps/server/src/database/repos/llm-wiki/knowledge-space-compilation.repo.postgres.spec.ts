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
  let secondClient: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let secondDb: Kysely<unknown>;
  let repo: KnowledgeSpaceCompilationRepo;
  let secondRepo: KnowledgeSpaceCompilationRepo;

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
    secondClient = postgres(normalizePostgresUrl(integrationDatabaseUrl!), {
      max: 1,
      onnotice: () => {},
    });
    secondDb = new Kysely({
      dialect: new PostgresJSDialect({ postgres: secondClient }),
      plugins: [new CamelCasePlugin()],
    });
    await sql.raw(`set search_path to "${schema}"`).execute(secondDb);
    secondRepo = new KnowledgeSpaceCompilationRepo(secondDb as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await secondDb?.destroy();
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
      aggregateRequired: true,
      status: 'queued',
      phase: 'text',
      sequence: 7,
      runPageCount: 0,
      runImageCount: 0,
    });
  });

  it('persists one queued active Run for each Space in a 100-Space request', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      select 'space-bulk-' || ordinal, 'workspace-1', 'Bulk ' || ordinal
      from generate_series(1, 100) ordinal
    `.execute(db);
    const requests = Array.from({ length: 100 }, (_, index) => ({
      workspaceId: 'workspace-1',
      spaceId: `space-bulk-${index + 1}`,
      trigger: 'manual_compile',
    }));

    const results = await repo.requestRuns({
      requests,
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });

    expect(results).toHaveLength(100);
    expect(results.every((result) => result.disposition === 'created')).toBe(
      true,
    );
    const evidence = await sql<{
      runCount: number;
      uninitializedCount: number;
      runPageCount: number;
    }>`
      select
        count(*)::integer as "runCount",
        count(*) filter (where initialized_at is null)::integer
          as "uninitializedCount",
        (select count(*)::integer
         from knowledge_space_compile_run_pages run_page
         join knowledge_space_compile_runs run on run.id = run_page.run_id
         where run.space_id like 'space-bulk-%') as "runPageCount"
      from knowledge_space_compile_runs
      where space_id like 'space-bulk-%'
        and status in ('queued', 'compiling', 'aggregate_pending', 'aggregating')
    `.execute(db);
    expect(evidence.rows).toEqual([
      { runCount: 100, uninitializedCount: 100, runPageCount: 0 },
    ]);
  });

  it('persists the target page scope for a page-scoped Run', async () => {
    const [created] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-scoped',
          trigger: 'page_retry',
          targetSourcePageIds: ['page-x', 'page-y'],
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });
    expect(created.disposition).toBe('created');
    const row = await sql<{ targetSourcePageIds: string[] | null }>`
      select target_source_page_ids as "targetSourcePageIds"
      from knowledge_space_compile_runs where id = ${created.run!.id}
    `.execute(db);
    expect(row.rows[0].targetSourcePageIds).toEqual(['page-x', 'page-y']);
  });

  it('keeps ordinary page updates page-scoped and unions changes for one follow-up', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-page-update', 'workspace-1', 'Page update');
      insert into pages (id, workspace_id, space_id) values
        ('page-update-a', 'workspace-1', 'space-page-update'),
        ('page-update-b', 'workspace-1', 'space-page-update')
    `.execute(db);

    const [first] = await repo.requestIncrementalCompileForPages({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-update-a'],
      trigger: 'page_update',
      removed: false,
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });
    expect(first.disposition).toBe('created');
    expect(first.run?.targetSourcePageIds).toEqual(['page-update-a']);

    // Once initialized, a second page cannot be added to the frozen RunPage
    // plan. It is durably unioned into the bounded follow-up scope instead.
    await sql`
      update knowledge_space_compile_runs
      set initialized_at = now(), status = 'compiling'
      where id = ${first.run!.id}
    `.execute(db);
    const [second] = await repo.requestIncrementalCompileForPages({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-update-b'],
      trigger: 'page_update',
      removed: false,
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });

    expect(second.disposition).toBe('rerun_requested');
    expect(second.run?.rerunRequested).toBe(true);
    expect(
      [...((second.run?.targetSourcePageIds as string[] | null) ?? [])].sort(),
    ).toEqual(['page-update-a', 'page-update-b']);
  });

  it('narrows the follow-up of an initialized full-Space Run to the changed page', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-full-active', 'workspace-1', 'Full active');
      insert into pages (id, workspace_id, space_id)
      values ('page-full-active', 'workspace-1', 'space-full-active')
    `.execute(db);
    const [full] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-full-active',
          trigger: 'manual_compile',
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });
    await sql`
      update knowledge_space_compile_runs
      set initialized_at = now(), status = 'compiling'
      where id = ${full.run!.id}
    `.execute(db);

    const [updated] = await repo.requestIncrementalCompileForPages({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-full-active'],
      trigger: 'page_update',
      removed: false,
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });

    expect(updated.disposition).toBe('rerun_requested');
    expect(updated.run?.targetSourcePageIds).toEqual(['page-full-active']);
  });

  it('unions target pages when coalescing two page-scoped requests', async () => {
    const [first] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-scoped-union',
          trigger: 'page_retry',
          targetSourcePageIds: ['page-a'],
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });
    const [second] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-scoped-union',
          trigger: 'page_retry',
          targetSourcePageIds: ['page-a', 'page-b'],
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });
    expect(second.disposition).toBe('coalesced');
    expect(second.run!.id).toBe(first.run!.id);
    const row = await sql<{ targetSourcePageIds: string[] | null }>`
      select target_source_page_ids as "targetSourcePageIds"
      from knowledge_space_compile_runs where id = ${first.run!.id}
    `.execute(db);
    expect([...(row.rows[0].targetSourcePageIds ?? [])].sort()).toEqual([
      'page-a',
      'page-b',
    ]);
  });

  it('widens a page-scoped Run to full-Space when a full request coalesces', async () => {
    const [scoped] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-scoped-widen',
          trigger: 'page_retry',
          targetSourcePageIds: ['page-a'],
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });
    const [full] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-scoped-widen',
          trigger: 'manual_compile',
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });
    expect(full.disposition).toBe('coalesced');
    expect(full.run!.id).toBe(scoped.run!.id);
    const row = await sql<{ targetSourcePageIds: string[] | null }>`
      select target_source_page_ids as "targetSourcePageIds"
      from knowledge_space_compile_runs where id = ${scoped.run!.id}
    `.execute(db);
    expect(row.rows[0].targetSourcePageIds).toBeNull();
  });

  it('applies a one-hour trailing debounce and atomically promotes the latest page', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-debounce', 'workspace-1', 'Debounce');
      insert into pages (id, workspace_id, space_id)
      values ('page-debounce', 'workspace-1', 'space-debounce')
    `.execute(db);
    const firstChange = new Date('2026-08-05T10:00:00.000Z');
    const lastChange = new Date('2026-08-05T10:40:00.000Z');
    await repo.scheduleIncrementalCompileForPages({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-debounce'],
      trigger: 'page_created',
      quietPeriodMs: 60 * 60 * 1_000,
      changedAt: firstChange,
    });
    await repo.scheduleIncrementalCompileForPages({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-debounce'],
      trigger: 'page_updated',
      quietPeriodMs: 60 * 60 * 1_000,
      changedAt: lastChange,
    });

    const schedule = await sql<{
      changeCount: number;
      firstChangedAt: Date;
      lastChangedAt: Date;
      eligibleAt: Date;
    }>`
      select change_count::integer as "changeCount",
             first_changed_at as "firstChangedAt",
             last_changed_at as "lastChangedAt",
             eligible_at as "eligibleAt"
      from knowledge_page_compile_schedules
      where source_page_id = 'page-debounce'
    `.execute(db);
    expect(schedule.rows[0]).toEqual({
      changeCount: 2,
      firstChangedAt: firstChange,
      lastChangedAt: lastChange,
      eligibleAt: new Date('2026-08-05T11:40:00.000Z'),
    });

    await expect(
      repo.promoteDuePageCompileSchedules({
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        now: new Date('2026-08-05T11:39:59.999Z'),
      }),
    ).resolves.toEqual({
      selectedPageCount: 0,
      promotedPageCount: 0,
      runRequestCount: 0,
    });
    await expect(
      repo.promoteDuePageCompileSchedules({
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        now: new Date('2026-08-05T11:40:00.000Z'),
      }),
    ).resolves.toEqual({
      selectedPageCount: 1,
      promotedPageCount: 1,
      runRequestCount: 1,
    });
    const promoted = await sql<{
      trigger: string;
      targetSourcePageIds: string[];
      scheduleCount: number;
    }>`
      select trigger,
             target_source_page_ids as "targetSourcePageIds",
             (select count(*)::integer
              from knowledge_page_compile_schedules
              where source_page_id = 'page-debounce') as "scheduleCount"
      from knowledge_space_compile_runs
      where space_id = 'space-debounce'
    `.execute(db);
    expect(promoted.rows).toEqual([
      {
        trigger: 'debounced_page_change',
        targetSourcePageIds: ['page-debounce'],
        scheduleCount: 0,
      },
    ]);
  });

  it('requires the exact page name before making one delayed page immediately due', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-immediate-page', 'workspace-1', 'Immediate page');
      insert into pages (id, workspace_id, space_id, title, slug_id)
      values (
        'page-immediate-page',
        'workspace-1',
        'space-immediate-page',
        'BeeGFS deployment',
        'beegfs-deployment'
      )
    `.execute(db);
    await repo.scheduleIncrementalCompileForPages({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-immediate-page'],
      trigger: 'page_updated',
      quietPeriodMs: 60 * 60 * 1_000,
      changedAt: new Date('2099-08-05T10:00:00.000Z'),
    });
    const scheduled = await sql<{ id: string; eligibleAt: Date }>`
      select id, eligible_at as "eligibleAt"
      from knowledge_page_compile_schedules
      where source_page_id = 'page-immediate-page'
    `.execute(db);

    await expect(
      repo.markDelayedPageForImmediateCompilation({
        workspaceId: 'workspace-1',
        scheduleId: scheduled.rows[0].id,
        confirmationPageName: 'wrong page',
      }),
    ).resolves.toBeNull();
    const unchanged = await sql<{ eligibleAt: Date }>`
      select eligible_at as "eligibleAt"
      from knowledge_page_compile_schedules
      where id = ${scheduled.rows[0].id}
    `.execute(db);
    expect(unchanged.rows[0].eligibleAt).toEqual(scheduled.rows[0].eligibleAt);

    await expect(
      repo.markDelayedPageForImmediateCompilation({
        workspaceId: 'workspace-1',
        scheduleId: scheduled.rows[0].id,
        confirmationPageName: 'BeeGFS deployment',
      }),
    ).resolves.toEqual({
      scheduleId: scheduled.rows[0].id,
      sourcePageId: 'page-immediate-page',
      spaceId: 'space-immediate-page',
      pageName: 'BeeGFS deployment',
    });
    await expect(
      repo.promoteDuePageCompileSchedules({
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
    ).resolves.toEqual({
      selectedPageCount: 1,
      promotedPageCount: 1,
      runRequestCount: 1,
    });
  });

  it('requires the exact page name before removing one delayed page', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-remove-delayed', 'workspace-1', 'Remove delayed');
      insert into pages (id, workspace_id, space_id, title, slug_id)
      values (
        'page-remove-delayed',
        'workspace-1',
        'space-remove-delayed',
        'Obsolete delayed page',
        'obsolete-delayed-page'
      )
    `.execute(db);
    await repo.scheduleIncrementalCompileForPages({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-remove-delayed'],
      trigger: 'page_updated',
      quietPeriodMs: 60 * 60 * 1_000,
      changedAt: new Date('2099-08-05T10:00:00.000Z'),
    });
    const scheduled = await sql<{ id: string }>`
      select id
      from knowledge_page_compile_schedules
      where source_page_id = 'page-remove-delayed'
    `.execute(db);

    await expect(
      repo.removeDelayedPageCompilation({
        workspaceId: 'workspace-1',
        scheduleId: scheduled.rows[0].id,
        confirmationPageName: 'wrong page',
      }),
    ).resolves.toBeNull();
    await expect(
      repo.removeDelayedPageCompilation({
        workspaceId: 'workspace-1',
        scheduleId: scheduled.rows[0].id,
        confirmationPageName: 'Obsolete delayed page',
      }),
    ).resolves.toEqual({
      scheduleId: scheduled.rows[0].id,
      sourcePageId: 'page-remove-delayed',
      spaceId: 'space-remove-delayed',
      pageName: 'Obsolete delayed page',
    });

    const remaining = await sql<{ count: number }>`
      select count(*)::integer as count
      from knowledge_page_compile_schedules
      where source_page_id = 'page-remove-delayed'
    `.execute(db);
    expect(remaining.rows).toEqual([{ count: 0 }]);
  });

  it('keeps manual Space compilation immediate and clears covered delays', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-manual-immediate', 'workspace-1', 'Manual immediate');
      insert into pages (id, workspace_id, space_id)
      values ('page-manual-immediate', 'workspace-1', 'space-manual-immediate')
    `.execute(db);
    await repo.scheduleIncrementalCompileForPages({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-manual-immediate'],
      trigger: 'page_updated',
      quietPeriodMs: 60 * 60 * 1_000,
    });

    const [result] = await repo.requestRuns({
      requests: [
        {
          workspaceId: 'workspace-1',
          spaceId: 'space-manual-immediate',
          trigger: 'manual_compile',
        },
      ],
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    });

    expect(result.disposition).toBe('created');
    const remaining = await sql<{ count: number }>`
      select count(*)::integer as count
      from knowledge_page_compile_schedules
      where space_id = 'space-manual-immediate'
    `.execute(db);
    expect(remaining.rows).toEqual([{ count: 0 }]);
  });

  it('lets two application instances promote disjoint due pages without duplicate active Runs', async () => {
    await sql`
      insert into spaces (id, workspace_id, name)
      values ('space-multi-instance-delay', 'workspace-1', 'Multi instance');
      insert into pages (id, workspace_id, space_id) values
        ('page-multi-instance-a', 'workspace-1', 'space-multi-instance-delay'),
        ('page-multi-instance-b', 'workspace-1', 'space-multi-instance-delay')
    `.execute(db);
    const changedAt = new Date('2026-08-05T08:00:00.000Z');
    await repo.scheduleIncrementalCompileForPages({
      workspaceId: 'workspace-1',
      sourcePageIds: ['page-multi-instance-a', 'page-multi-instance-b'],
      trigger: 'page_updated',
      quietPeriodMs: 0,
      changedAt,
    });

    const results = await Promise.all([
      repo.promoteDuePageCompileSchedules({
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        limit: 1,
        now: changedAt,
      }),
      secondRepo.promoteDuePageCompileSchedules({
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        limit: 1,
        now: changedAt,
      }),
    ]);

    expect(
      results.reduce((sum, result) => sum + result.selectedPageCount, 0),
    ).toBe(2);
    const evidence = await sql<{
      runCount: number;
      targetSourcePageIds: string[];
      scheduleCount: number;
    }>`
      select count(*)::integer as "runCount",
             (select target_source_page_ids
              from knowledge_space_compile_runs
              where space_id = 'space-multi-instance-delay'
                and status in ('queued', 'compiling', 'aggregate_pending', 'aggregating')
              limit 1) as "targetSourcePageIds",
             (select count(*)::integer
              from knowledge_page_compile_schedules
              where space_id = 'space-multi-instance-delay') as "scheduleCount"
      from knowledge_space_compile_runs
      where space_id = 'space-multi-instance-delay'
        and status in ('queued', 'compiling', 'aggregate_pending', 'aggregating')
    `.execute(db);
    expect(evidence.rows[0].runCount).toBe(1);
    expect([...evidence.rows[0].targetSourcePageIds].sort()).toEqual([
      'page-multi-instance-a',
      'page-multi-instance-b',
    ]);
    expect(evidence.rows[0].scheduleCount).toBe(0);
  });
});

async function createFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create sequence run_id_seq;
    create sequence run_page_id_seq;
    create sequence schedule_id_seq;
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
      target_source_page_ids jsonb,
      aggregate_required boolean not null default true,
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
      title varchar,
      slug_id varchar,
      deleted_at timestamptz
    );
    create table knowledge_page_compile_schedules (
      id varchar primary key default ('schedule-' || nextval('schedule_id_seq')),
      workspace_id varchar not null,
      space_id varchar not null,
      source_page_id varchar not null,
      trigger varchar not null,
      change_count integer not null default 1,
      first_changed_at timestamptz not null,
      last_changed_at timestamptz not null,
      eligible_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (workspace_id, source_page_id)
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
      ('space-fair-merge', 'workspace-1', 'Fair merge'),
      ('space-scoped', 'workspace-1', 'Page scoped'),
      ('space-scoped-union', 'workspace-1', 'Page scoped union'),
      ('space-scoped-widen', 'workspace-1', 'Page scoped widen')
  `.execute(db);
}

async function seedInitializedRemovedSourcePlan(
  db: Kysely<unknown>,
  runId: string,
): Promise<void> {
  await sql`
    update knowledge_space_compile_runs
    set initialized_at = now(), status = 'compiling', space_job_sequence = 7,
        execution_token = 'old-token', aggregate_required = false
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
    aggregateRequired: boolean;
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
      run.initialized_at as "initializedAt",
      run.aggregate_required as "aggregateRequired", run.status, run.phase,
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
