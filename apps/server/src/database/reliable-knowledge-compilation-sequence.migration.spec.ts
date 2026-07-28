import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../common/helpers';

const migrationFiles = [
  '20260728T100000-reliable-knowledge-compilation.ts',
  '20260728T110000-knowledge-image-attachment-version.ts',
  '20260728T120000-knowledge-image-run-page-skips.ts',
] as const;
const migrationPaths = migrationFiles.map((file) =>
  resolve(__dirname, 'migrations', file),
);
const databaseTypesPath = resolve(__dirname, 'types/db.d.ts');
const entityTypesPath = resolve(__dirname, 'types/entity.types.ts');

type Migration = {
  up(database: Kysely<unknown>): Promise<void>;
  down(database: Kysely<unknown>): Promise<void>;
};

describe('reliable knowledge compilation migration sequence', () => {
  it('orders the dependent migrations and keeps conservative backfill semantics', async () => {
    expect([...migrationFiles].sort()).toEqual(migrationFiles);

    const [reliable, attachmentVersion, skippedImages] = await Promise.all(
      migrationPaths.map((migrationPath) => readFile(migrationPath, 'utf8')),
    );

    expect(reliable).toContain(
      'chk_knowledge_space_compile_run_pages_image_counts',
    );
    expect(attachmentVersion).toContain(
      ".addColumn('attachment_version', 'timestamptz')",
    );
    expect(attachmentVersion).not.toContain(
      ".addColumn('attachment_version', 'timestamptz',",
    );
    expect(skippedImages).toContain(
      ".addColumn('skipped_image_count', 'integer', (col) =>",
    );
    expect(skippedImages).toContain('col.notNull().defaultTo(0)');
    expect(skippedImages).toContain(
      'succeeded_image_count + failed_image_count + skipped_image_count',
    );
  });

  it('keeps generated database and entity contracts aligned with the schema', async () => {
    const [databaseTypes, entityTypes] = await Promise.all([
      readFile(databaseTypesPath, 'utf8'),
      readFile(entityTypesPath, 'utf8'),
    ]);
    const spaces = interfaceBody(databaseTypes, 'Spaces');
    const runs = interfaceBody(databaseTypes, 'KnowledgeSpaceCompileRuns');
    const runPages = interfaceBody(
      databaseTypes,
      'KnowledgeSpaceCompileRunPages',
    );
    const attempts = interfaceBody(
      databaseTypes,
      'KnowledgeCompilationAttempts',
    );
    const extractions = interfaceBody(
      databaseTypes,
      'KnowledgeImageExtractions',
    );

    expect(spaces).toContain('knowledgeGeneration: Generated<number>;');
    expect(runs).toContain('knowledgeGeneration: Generated<number>;');
    expect(runs).toContain('mode: Generated<string>;');
    expect(runs).toContain('phase: Generated<string>;');
    expect(runPages).toContain('expectedImageCount: Generated<number>;');
    expect(runPages).toContain('succeededImageCount: Generated<number>;');
    expect(runPages).toContain('failedImageCount: Generated<number>;');
    expect(runPages).toContain('skippedImageCount: Generated<number>;');
    expect(runPages).toContain('imageStatus: Generated<string>;');
    expect(runPages).toContain('mergeStatus: Generated<string>;');
    expect(attempts).toContain('effectiveKnowledgeHash: string | null;');
    expect(attempts).toContain('lastSuccessfulEffectiveHash: string | null;');
    expect(extractions).toContain('attachmentVersion: Timestamp | null;');

    expect(entityTypes).toContain('Selectable<KnowledgeSpaceCompileRunPages>');
    expect(entityTypes).toContain('Selectable<KnowledgeImageExtractions>');
  });
});

function interfaceBody(source: string, interfaceName: string): string {
  const match = source.match(
    new RegExp(`export interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`),
  );
  expect(match).toBeTruthy();
  return match?.[1] ?? '';
}

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres(
  'reliable knowledge compilation ordered PostgreSQL round trip',
  () => {
    const schema = `akasha_migration_sequence_${process.pid}_${Date.now()}`;
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
      await createProductionShapedFixture(db);
    });

    afterAll(async () => {
      if (!db) return;
      await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
      await db.destroy();
    });

    it('preserves legacy rows through 100000 -> 110000 -> 120000 -> down -> up', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const migrations = migrationPaths.map((migrationPath) =>
        require(migrationPath),
      ) as Migration[];

      await runUp(migrations, db);
      await expectCurrentSchema(db);
      await expectLegacyRowsUseConservativeDefaults(db);
      await expectConstraintsAreEnforced(db);
      await logSequenceEvidence('first_up', schema, db);

      await sql`
        update knowledge_image_extractions
        set attachment_version = '2026-07-28T01:02:03.000Z'
        where id = '00000000-0000-0000-0000-000000000005'
      `.execute(db);
      await sql`
        update knowledge_space_compile_run_pages
        set expected_image_count = 2,
            succeeded_image_count = 1,
            skipped_image_count = 1,
            image_status = 'partial',
            merge_status = 'succeeded'
        where id = '00000000-0000-0000-0000-000000000003'
      `.execute(db);

      await runDown(migrations, db);
      await expectLegacySchemaAndRowsRemain(db);
      await logSequenceEvidence('down', schema, db);

      await runUp(migrations, db);
      await expectCurrentSchema(db);
      await expectLegacyRowsUseConservativeDefaults(db);
      await logSequenceEvidence('second_up', schema, db);
    });
  },
);

async function runUp(
  migrations: Migration[],
  db: Kysely<unknown>,
): Promise<void> {
  for (const migration of migrations) await migration.up(db);
}

async function runDown(
  migrations: Migration[],
  db: Kysely<unknown>,
): Promise<void> {
  for (const migration of [...migrations].reverse()) await migration.down(db);
}

async function createProductionShapedFixture(
  db: Kysely<unknown>,
): Promise<void> {
  await sql`
    create table spaces (
      id uuid primary key,
      workspace_id uuid not null,
      slug varchar not null,
      name varchar,
      created_at timestamptz not null default now()
    );
    create table knowledge_space_compile_runs (
      id uuid primary key,
      workspace_id uuid not null,
      space_id uuid not null,
      trigger varchar not null,
      status varchar not null default 'queued',
      expected_page_count integer not null default 0,
      succeeded_page_count integer not null default 0,
      failed_page_count integer not null default 0,
      skipped_page_count integer not null default 0,
      compiler_version varchar not null,
      prompt_version varchar not null,
      catalog_snapshot jsonb not null default '[]'::jsonb,
      catalog_hash varchar not null,
      created_at timestamptz not null default now()
    );
    create table knowledge_space_compile_run_pages (
      id uuid primary key,
      run_id uuid not null,
      workspace_id uuid not null,
      space_id uuid not null,
      source_page_id uuid not null,
      expected_source_version varchar not null,
      expected_source_content_hash varchar not null,
      status varchar not null default 'pending',
      created_at timestamptz not null default now()
    );
    create table knowledge_compilation_attempts (
      id uuid primary key,
      workspace_id uuid not null,
      space_id uuid not null,
      source_page_id uuid not null,
      status varchar not null default 'queued',
      stage varchar not null default 'queued',
      compiler_version varchar not null,
      prompt_version varchar not null,
      created_at timestamptz not null default now()
    );
    create table knowledge_image_extractions (
      id uuid primary key,
      workspace_id uuid not null,
      attachment_id uuid not null,
      content_hash varchar not null,
      cache_fingerprint varchar not null,
      model varchar not null,
      prompt_version varchar not null,
      status varchar not null,
      attempt_count integer not null default 0,
      created_at timestamptz not null default now()
    );

    insert into spaces (id, workspace_id, slug, name) values (
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000010',
      'legacy-space',
      'Legacy Space'
    );
    insert into knowledge_space_compile_runs (
      id, workspace_id, space_id, trigger, status, expected_page_count,
      succeeded_page_count, compiler_version, prompt_version, catalog_hash
    ) values (
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000001',
      'manual', 'succeeded', 1, 1, 'legacy-compiler', 'legacy-prompt',
      'legacy-catalog'
    );
    insert into knowledge_space_compile_run_pages (
      id, run_id, workspace_id, space_id, source_page_id,
      expected_source_version, expected_source_content_hash, status
    ) values (
      '00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000020',
      'legacy-version', 'legacy-source-hash', 'succeeded'
    );
    insert into knowledge_compilation_attempts (
      id, workspace_id, space_id, source_page_id, status, stage,
      compiler_version, prompt_version
    ) values (
      '00000000-0000-0000-0000-000000000004',
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000020',
      'succeeded', 'persisted', 'legacy-compiler', 'legacy-prompt'
    );
    insert into knowledge_image_extractions (
      id, workspace_id, attachment_id, content_hash, cache_fingerprint,
      model, prompt_version, status
    ) values (
      '00000000-0000-0000-0000-000000000005',
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000030',
      'legacy-image-hash', 'legacy-fingerprint', 'legacy-model',
      'legacy-prompt', 'ready'
    );
  `.execute(db);
}

async function expectCurrentSchema(db: Kysely<unknown>): Promise<void> {
  const columns = await sql<{
    tableName: string;
    columnName: string;
    isNullable: 'YES' | 'NO';
    columnDefault: string | null;
  }>`
    select
      table_name as "tableName",
      column_name as "columnName",
      is_nullable as "isNullable",
      column_default as "columnDefault"
    from information_schema.columns
    where table_schema = current_schema()
      and (
        (table_name = 'knowledge_image_extractions'
          and column_name = 'attachment_version')
        or (table_name = 'knowledge_space_compile_run_pages'
          and column_name = 'skipped_image_count')
      )
    order by table_name, column_name
  `.execute(db);
  expect(columns.rows).toEqual([
    {
      tableName: 'knowledge_image_extractions',
      columnName: 'attachment_version',
      isNullable: 'YES',
      columnDefault: null,
    },
    {
      tableName: 'knowledge_space_compile_run_pages',
      columnName: 'skipped_image_count',
      isNullable: 'NO',
      columnDefault: '0',
    },
  ]);

  const constraint = await sql<{ validated: boolean }>`
    select convalidated as validated
    from pg_constraint
    where conrelid = 'knowledge_space_compile_run_pages'::regclass
      and conname = 'chk_knowledge_space_compile_run_pages_image_counts'
  `.execute(db);
  expect(constraint.rows).toEqual([{ validated: true }]);
}

async function expectLegacyRowsUseConservativeDefaults(
  db: Kysely<unknown>,
): Promise<void> {
  const rows = await sql<{
    slug: string;
    generation: number;
    mode: string;
    phase: string;
    sourceVersion: string;
    expectedImages: number;
    succeededImages: number;
    failedImages: number;
    skippedImages: number;
    attachmentVersion: Date | null;
    contentHash: string;
  }>`
    select
      space.slug,
      space.knowledge_generation as generation,
      run.mode,
      run.phase,
      run_page.expected_source_version as "sourceVersion",
      run_page.expected_image_count as "expectedImages",
      run_page.succeeded_image_count as "succeededImages",
      run_page.failed_image_count as "failedImages",
      run_page.skipped_image_count as "skippedImages",
      extraction.attachment_version as "attachmentVersion",
      extraction.content_hash as "contentHash"
    from spaces space
    cross join knowledge_space_compile_runs run
    cross join knowledge_space_compile_run_pages run_page
    cross join knowledge_image_extractions extraction
  `.execute(db);
  expect(rows.rows).toEqual([
    {
      slug: 'legacy-space',
      generation: 0,
      mode: 'incremental',
      phase: 'text',
      sourceVersion: 'legacy-version',
      expectedImages: 0,
      succeededImages: 0,
      failedImages: 0,
      skippedImages: 0,
      attachmentVersion: null,
      contentHash: 'legacy-image-hash',
    },
  ]);
}

async function expectConstraintsAreEnforced(
  db: Kysely<unknown>,
): Promise<void> {
  await expect(
    sql`
      update knowledge_space_compile_run_pages
      set skipped_image_count = -1
    `.execute(db),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    sql`
      update knowledge_space_compile_run_pages
      set expected_image_count = 1,
          succeeded_image_count = 1,
          skipped_image_count = 1
    `.execute(db),
  ).rejects.toMatchObject({ code: '23514' });
}

async function expectLegacySchemaAndRowsRemain(
  db: Kysely<unknown>,
): Promise<void> {
  const addedColumns = await sql<{ count: number }>`
    select count(*)::integer as count
    from information_schema.columns
    where table_schema = current_schema()
      and column_name in (
        'knowledge_generation', 'mode', 'phase', 'expected_image_count',
        'succeeded_image_count', 'failed_image_count', 'skipped_image_count',
        'attachment_version', 'image_status', 'image_job_id', 'merge_status',
        'merge_job_id', 'target_effective_knowledge_hash',
        'merged_effective_knowledge_hash', 'effective_knowledge_hash',
        'last_successful_effective_hash'
      )
  `.execute(db);
  expect(addedColumns.rows).toEqual([{ count: 0 }]);

  const rows = await sql<{
    slug: string;
    catalogHash: string;
    sourceVersion: string;
    attemptStage: string;
    contentHash: string;
  }>`
    select
      space.slug,
      run.catalog_hash as "catalogHash",
      run_page.expected_source_version as "sourceVersion",
      attempt.stage as "attemptStage",
      extraction.content_hash as "contentHash"
    from spaces space
    cross join knowledge_space_compile_runs run
    cross join knowledge_space_compile_run_pages run_page
    cross join knowledge_compilation_attempts attempt
    cross join knowledge_image_extractions extraction
  `.execute(db);
  expect(rows.rows).toEqual([
    {
      slug: 'legacy-space',
      catalogHash: 'legacy-catalog',
      sourceVersion: 'legacy-version',
      attemptStage: 'persisted',
      contentHash: 'legacy-image-hash',
    },
  ]);
}

async function logSequenceEvidence(
  stage: string,
  schema: string,
  db: Kysely<unknown>,
): Promise<void> {
  if (process.env.AKASHA_MIGRATION_TEST_EVIDENCE !== '1') return;

  const evidence = await sql<{
    legacyRowCount: number;
    attachmentVersionColumns: number;
    skippedImageCountColumns: number;
  }>`
    select
      (
        select count(*)::integer
        from knowledge_image_extractions
        where content_hash = 'legacy-image-hash'
      ) as "legacyRowCount",
      (
        select count(*)::integer
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'knowledge_image_extractions'
          and column_name = 'attachment_version'
      ) as "attachmentVersionColumns",
      (
        select count(*)::integer
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'knowledge_space_compile_run_pages'
          and column_name = 'skipped_image_count'
      ) as "skippedImageCountColumns"
  `.execute(db);

  console.info(
    'knowledge_migration_sequence_database_evidence',
    JSON.stringify({ stage, schema, ...evidence.rows[0] }),
  );
}
