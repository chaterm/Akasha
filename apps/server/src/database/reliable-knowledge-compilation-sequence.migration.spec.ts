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
  '20260731T100000-multi-space-compilation.ts',
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

    const [reliable, attachmentVersion, skippedImages, multiSpace] =
      await Promise.all(
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
    expect(multiSpace).not.toContain(".addColumn('skipped_image_count'");
    expect(multiSpace).toContain(
      ".createTable('knowledge_space_compile_run_images')",
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
    const runImages = interfaceBody(
      databaseTypes,
      'KnowledgeSpaceCompileRunImages',
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
    expect(runs).toContain('initializedAt: Timestamp | null;');
    expect(runs).toContain('spaceJobSequence: Generated<number>;');
    expect(runPages).toContain('expectedImageCount: Generated<number>;');
    expect(runPages).toContain('succeededImageCount: Generated<number>;');
    expect(runPages).toContain('failedImageCount: Generated<number>;');
    expect(runPages).toContain('skippedImageCount: Generated<number>;');
    expect(runPages).toContain('imageStatus: Generated<string>;');
    expect(runPages).toContain('mergeStatus: Generated<string>;');
    expect(runImages).toContain('imageOrdinal: number;');
    expect(runImages).toContain('expectedAttachmentVersion: Timestamp;');
    expect(attempts).toContain('effectiveKnowledgeHash: string | null;');
    expect(attempts).toContain('lastSuccessfulEffectiveHash: string | null;');
    expect(extractions).toContain('attachmentVersion: Timestamp | null;');

    expect(entityTypes).toContain('Selectable<KnowledgeSpaceCompileRunPages>');
    expect(entityTypes).toContain('Selectable<KnowledgeSpaceCompileRunImages>');
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

    it('preserves legacy rows through the full sequence -> down -> up', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const migrations = migrationPaths.map((migrationPath) =>
        require(migrationPath),
      ) as Migration[];

      await runUp(migrations, db);
      await expectCurrentSchema(db);
      await expectLegacyRowsUseConservativeDefaults(db);
      await expectConstraintsAreEnforced(db);
      await expectMillisecondAttachmentFence(db);
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
    create function gen_uuid_v7() returns uuid
    language sql as 'select gen_random_uuid()';
    create table workspaces (
      id uuid primary key
    );
    create table attachments (
      id uuid primary key,
      updated_at timestamptz not null
    );
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
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
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

    insert into workspaces (id) values (
      '00000000-0000-0000-0000-000000000010'
    );
    insert into attachments (id, updated_at) values (
      '00000000-0000-0000-0000-000000000030',
      '2026-07-31T01:02:03.123456Z'
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
        or (table_name = 'knowledge_space_compile_runs'
          and column_name in (
            'initialized_at', 'space_job_sequence',
            'space_job_recovery_count', 'execution_token',
            'rerun_requested'
          ))
      )
    order by table_name, column_name
  `.execute(db);
  expect(columns.rows).toEqual(
    expect.arrayContaining([
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
      expect.objectContaining({
        tableName: 'knowledge_space_compile_runs',
        columnName: 'space_job_sequence',
        isNullable: 'NO',
        columnDefault: '0',
      }),
    ]),
  );

  const imageTable = await sql<{ tableName: string | null }>`
    select to_regclass(
      current_schema() || '.knowledge_space_compile_run_images'
    )::text as "tableName"
  `.execute(db);
  expect(imageTable.rows[0]?.tableName).toContain(
    'knowledge_space_compile_run_images',
  );

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
  await expect(
    sql`
      update knowledge_space_compile_runs
      set space_job_recovery_count = 4
    `.execute(db),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    sql`
      insert into knowledge_space_compile_run_images (
        run_id, run_page_id, workspace_id, space_id, source_page_id,
        attachment_id, image_ordinal, file_name, mime_type,
        expected_attachment_version, status
      ) values (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000020',
        '00000000-0000-0000-0000-000000000030',
        50, 'invalid.png', 'image/png', now(), 'pending'
      )
    `.execute(db),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    sql`
      insert into knowledge_space_compile_run_images (
        run_id, run_page_id, workspace_id, space_id, source_page_id,
        attachment_id, image_ordinal, file_name, mime_type,
        expected_attachment_version, status, failure_class
      ) values (
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000020',
        '00000000-0000-0000-0000-000000000030',
        0, 'invalid.png', 'image/png', now(), 'failed', null
      )
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
        'last_successful_effective_hash', 'initialized_at', 'space_job_id',
        'space_job_dispatched_at', 'space_job_sequence',
        'space_job_queued_at', 'space_job_recovery_count', 'execution_token',
        'execution_lease_expires_at', 'worker_id', 'heartbeat_at',
        'last_yield_at', 'last_yield_reason', 'rerun_requested'
      )
  `.execute(db);
  expect(addedColumns.rows).toEqual([{ count: 0 }]);

  const imageTable = await sql<{ tableName: string | null }>`
    select to_regclass(
      current_schema() || '.knowledge_space_compile_run_images'
    )::text as "tableName"
  `.execute(db);
  expect(imageTable.rows).toEqual([{ tableName: null }]);

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

async function expectMillisecondAttachmentFence(
  db: Kysely<unknown>,
): Promise<void> {
  await sql`
    insert into knowledge_space_compile_run_images (
      id, run_id, run_page_id, workspace_id, space_id, source_page_id,
      attachment_id, image_ordinal, file_name, mime_type, file_size,
      expected_attachment_version, status
    ) values (
      '00000000-0000-0000-0000-000000000040',
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000020',
      '00000000-0000-0000-0000-000000000030',
      0, 'diagram.png', 'image/png', 10,
      '2026-07-31T01:02:03.123Z', 'pending'
    )
    on conflict (id) do nothing
  `.execute(db);
  const fence = await sql<{ exactMatch: boolean; millisecondMatch: boolean }>`
    select
      image.expected_attachment_version = attachment.updated_at
        as "exactMatch",
      date_trunc('milliseconds', image.expected_attachment_version)
        = date_trunc('milliseconds', attachment.updated_at)
        as "millisecondMatch"
    from knowledge_space_compile_run_images image
    join attachments attachment on attachment.id = image.attachment_id
    where image.id = '00000000-0000-0000-0000-000000000040'
  `.execute(db);
  expect(fence.rows).toEqual([{ exactMatch: false, millisecondMatch: true }]);
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
