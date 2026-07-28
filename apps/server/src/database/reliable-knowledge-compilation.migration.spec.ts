import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../common/helpers';

const migrationPath = resolve(
  __dirname,
  'migrations/20260728T100000-reliable-knowledge-compilation.ts',
);

describe('reliable knowledge compilation migration', () => {
  it('declares all durable orchestration fields and database constraints', async () => {
    const source = await readFile(migrationPath, 'utf8');

    for (const column of [
      'knowledge_generation',
      'mode',
      'phase',
      'expected_image_count',
      'succeeded_image_count',
      'failed_image_count',
      'image_status',
      'image_job_id',
      'merge_status',
      'merge_job_id',
      'target_effective_knowledge_hash',
      'merged_effective_knowledge_hash',
      'effective_knowledge_hash',
      'last_successful_effective_hash',
    ]) {
      expect(source).toContain(`'${column}'`);
    }

    expect(source).toContain('chk_spaces_knowledge_generation');
    expect(source).toContain('chk_knowledge_space_compile_runs_mode');
    expect(source).toContain('chk_knowledge_space_compile_runs_phase');
    expect(source).toContain(
      'chk_knowledge_space_compile_run_pages_image_counts',
    );
    expect(source).toContain(
      'chk_knowledge_space_compile_run_pages_image_status',
    );
    expect(source).toContain(
      'chk_knowledge_space_compile_run_pages_merge_status',
    );
  });
});

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('reliable knowledge compilation PostgreSQL round trip', () => {
  const schema = `akasha_knowledge_migration_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    client = postgres(normalizePostgresUrl(integrationDatabaseUrl!), {
      max: 1,
      onnotice: () => {},
    });
    db = new Kysely({ dialect: new PostgresJSDialect({ postgres: client }) });
    await sql.raw(`create schema "${schema}"`).execute(db);
    await sql.raw(`set search_path to "${schema}"`).execute(db);
    await createHistoricalFixture(db);
  });

  afterAll(async () => {
    if (db) {
      await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
      await db.destroy();
    }
  });

  it('preserves historical rows across Up -> Down -> Up', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const migration = require(migrationPath) as {
      up(database: Kysely<unknown>): Promise<void>;
      down(database: Kysely<unknown>): Promise<void>;
    };

    await logDatabaseEvidence('before_up', db);
    await migration.up(db);
    await expectDurableColumnCount(db, 15);
    await expectHistoricalDefaults(db);
    await logDatabaseEvidence('after_up_defaults', db);
    await expectPlannedImageStatesAreAccepted(db);
    await logDatabaseEvidence('after_planned_image_states', db);
    await expectConstraintsRejectInvalidValues(db);

    await migration.down(db);
    await expectDurableColumnCount(db, 0);
    await expectHistoricalRowsRemain(db);
    await logDatabaseEvidence('after_down', db);

    await migration.up(db);
    await expectDurableColumnCount(db, 15);
    await expectHistoricalDefaults(db);
    await logDatabaseEvidence('after_second_up', db);
  });
});

async function logDatabaseEvidence(
  stage: string,
  db: Kysely<unknown>,
): Promise<void> {
  if (process.env.AKASHA_MIGRATION_TEST_EVIDENCE !== '1') return;

  const counts = await sql<{
    durableColumnCount: number;
    historicalRowCount: number;
  }>`
    select
      (
        select count(*)::integer
        from information_schema.columns
        where table_schema = current_schema()
          and (
            (table_name = 'spaces' and column_name in (
              'knowledge_generation'
            )) or
            (table_name = 'knowledge_space_compile_runs' and column_name in (
              'mode', 'knowledge_generation', 'phase'
            )) or
            (table_name = 'knowledge_space_compile_run_pages' and column_name in (
              'expected_image_count', 'succeeded_image_count',
              'failed_image_count', 'image_status', 'image_job_id',
              'merge_status', 'merge_job_id',
              'target_effective_knowledge_hash',
              'merged_effective_knowledge_hash'
            )) or
            (table_name = 'knowledge_compilation_attempts' and column_name in (
              'effective_knowledge_hash', 'last_successful_effective_hash'
            ))
          )
      ) as "durableColumnCount",
      (
        select sum(row_count)::integer
        from (
          select count(*) as row_count from spaces
          union all select count(*) from knowledge_space_compile_runs
          union all select count(*) from knowledge_space_compile_run_pages
          union all select count(*) from knowledge_compilation_attempts
          union all select count(*) from knowledge_image_extractions
        ) rows
      ) as "historicalRowCount"
  `.execute(db);

  let values: Record<string, unknown> | undefined;
  if (counts.rows[0]?.durableColumnCount === 15) {
    const valueResult = await sql<Record<string, unknown>>`
      select
        s.knowledge_generation as "spaceGeneration",
        r.mode as "runMode",
        r.knowledge_generation as "runGeneration",
        r.phase as "runPhase",
        rp.expected_image_count as "expectedImages",
        rp.succeeded_image_count as "succeededImages",
        rp.failed_image_count as "failedImages",
        rp.image_status as "imageStatus",
        rp.merge_status as "mergeStatus"
      from spaces s
      cross join knowledge_space_compile_runs r
      cross join knowledge_space_compile_run_pages rp
    `.execute(db);
    values = valueResult.rows[0];
  }

  console.info(
    'knowledge_migration_database_evidence',
    JSON.stringify({ stage, ...counts.rows[0], values }),
  );
}

async function createHistoricalFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table spaces (
      id uuid primary key
    );
    create table knowledge_space_compile_runs (
      id uuid primary key
    );
    create table knowledge_space_compile_run_pages (
      id uuid primary key
    );
    create table knowledge_compilation_attempts (
      id uuid primary key
    );
    create table knowledge_image_extractions (
      id uuid primary key
    );
    insert into spaces values ('00000000-0000-0000-0000-000000000001');
    insert into knowledge_space_compile_runs values
      ('00000000-0000-0000-0000-000000000002');
    insert into knowledge_space_compile_run_pages values
      ('00000000-0000-0000-0000-000000000003');
    insert into knowledge_compilation_attempts values
      ('00000000-0000-0000-0000-000000000004');
    insert into knowledge_image_extractions values
      ('00000000-0000-0000-0000-000000000005');
  `.execute(db);
}

async function expectDurableColumnCount(
  db: Kysely<unknown>,
  expected: number,
): Promise<void> {
  const result = await sql<{ count: number }>`
    select count(*)::integer as count
    from information_schema.columns
    where table_schema = current_schema()
      and (
        (table_name = 'spaces' and column_name in (
          'knowledge_generation'
        )) or
        (table_name = 'knowledge_space_compile_runs' and column_name in (
          'mode', 'knowledge_generation', 'phase'
        )) or
        (table_name = 'knowledge_space_compile_run_pages' and column_name in (
          'expected_image_count', 'succeeded_image_count',
          'failed_image_count', 'image_status', 'image_job_id',
          'merge_status', 'merge_job_id',
          'target_effective_knowledge_hash',
          'merged_effective_knowledge_hash'
        )) or
        (table_name = 'knowledge_compilation_attempts' and column_name in (
          'effective_knowledge_hash', 'last_successful_effective_hash'
        ))
      )
  `.execute(db);
  expect(result.rows).toEqual([{ count: expected }]);
}

async function expectHistoricalDefaults(db: Kysely<unknown>): Promise<void> {
  const space = await sql<{
    knowledgeGeneration: number;
  }>`select knowledge_generation as "knowledgeGeneration" from spaces`.execute(
    db,
  );
  expect(space.rows).toEqual([{ knowledgeGeneration: 0 }]);

  const run = await sql<{
    mode: string;
    knowledgeGeneration: number;
    phase: string;
  }>`
    select mode, knowledge_generation as "knowledgeGeneration", phase
    from knowledge_space_compile_runs
  `.execute(db);
  expect(run.rows).toEqual([
    { mode: 'incremental', knowledgeGeneration: 0, phase: 'text' },
  ]);

  const page = await sql<{
    expectedImageCount: number;
    succeededImageCount: number;
    failedImageCount: number;
    imageStatus: string;
    mergeStatus: string;
  }>`
    select
      expected_image_count as "expectedImageCount",
      succeeded_image_count as "succeededImageCount",
      failed_image_count as "failedImageCount",
      image_status as "imageStatus",
      merge_status as "mergeStatus"
    from knowledge_space_compile_run_pages
  `.execute(db);
  expect(page.rows).toEqual([
    {
      expectedImageCount: 0,
      succeededImageCount: 0,
      failedImageCount: 0,
      imageStatus: 'not_required',
      mergeStatus: 'not_required',
    },
  ]);

  await expectHistoricalRowsRemain(db);
}

async function expectHistoricalRowsRemain(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ rowCount: number }>`
    select sum(row_count)::integer as "rowCount"
    from (
      select count(*) as row_count from spaces
      union all select count(*) from knowledge_space_compile_runs
      union all select count(*) from knowledge_space_compile_run_pages
      union all select count(*) from knowledge_compilation_attempts
      union all select count(*) from knowledge_image_extractions
    ) rows
  `.execute(db);
  expect(result.rows).toEqual([{ rowCount: 5 }]);
}

async function expectPlannedImageStatesAreAccepted(
  db: Kysely<unknown>,
): Promise<void> {
  await sql`
    update knowledge_space_compile_run_pages
    set image_status = 'pending', merge_status = 'waiting_images'
  `.execute(db);
  const result = await sql<{ imageStatus: string; mergeStatus: string }>`
    select
      image_status as "imageStatus",
      merge_status as "mergeStatus"
    from knowledge_space_compile_run_pages
  `.execute(db);
  expect(result.rows).toEqual([
    { imageStatus: 'pending', mergeStatus: 'waiting_images' },
  ]);
}

async function expectConstraintsRejectInvalidValues(
  db: Kysely<unknown>,
): Promise<void> {
  await expect(
    sql`update spaces set knowledge_generation = -1`.execute(db),
  ).rejects.toThrow(/chk_spaces_knowledge_generation/);
  await expect(
    sql`
      update knowledge_space_compile_runs set knowledge_generation = -1
    `.execute(db),
  ).rejects.toThrow(/chk_knowledge_space_compile_runs_knowledge_generation/);
  await expect(
    sql`update knowledge_space_compile_runs set mode = 'unknown'`.execute(db),
  ).rejects.toThrow(/chk_knowledge_space_compile_runs_mode/);
  await expect(
    sql`update knowledge_space_compile_runs set phase = 'unknown'`.execute(db),
  ).rejects.toThrow(/chk_knowledge_space_compile_runs_phase/);
  await expect(
    sql`
      update knowledge_space_compile_run_pages
      set expected_image_count = -1
    `.execute(db),
  ).rejects.toThrow(/chk_knowledge_space_compile_run_pages_image_counts/);
  await expect(
    sql`
      update knowledge_space_compile_run_pages
      set succeeded_image_count = -1
    `.execute(db),
  ).rejects.toThrow(/chk_knowledge_space_compile_run_pages_image_counts/);
  await expect(
    sql`
      update knowledge_space_compile_run_pages
      set failed_image_count = -1
    `.execute(db),
  ).rejects.toThrow(/chk_knowledge_space_compile_run_pages_image_counts/);
  await expect(
    sql`
      update knowledge_space_compile_run_pages
      set
        expected_image_count = 1,
        succeeded_image_count = 1,
        failed_image_count = 1
    `.execute(db),
  ).rejects.toThrow(/chk_knowledge_space_compile_run_pages_image_counts/);
  await expect(
    sql`
      update knowledge_space_compile_run_pages
      set image_status = 'unknown'
    `.execute(db),
  ).rejects.toThrow(/chk_knowledge_space_compile_run_pages_image_status/);
  await expect(
    sql`
      update knowledge_space_compile_run_pages
      set merge_status = 'unknown'
    `.execute(db),
  ).rejects.toThrow(/chk_knowledge_space_compile_run_pages_merge_status/);
}
