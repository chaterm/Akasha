import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('knowledge_space_compile_runs')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('trigger', 'varchar', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('queued'))
    .addColumn('expected_page_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('succeeded_page_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('failed_page_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('skipped_page_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('compiler_version', 'varchar', (col) => col.notNull())
    .addColumn('prompt_version', 'varchar', (col) => col.notNull())
    .addColumn('catalog_snapshot', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn('catalog_hash', 'varchar', (col) => col.notNull())
    .addColumn('aggregate_job_id', 'varchar')
    .addColumn('imported_artifact_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('quarantined_artifact_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('error_code', 'varchar')
    .addColumn('error_message', 'varchar')
    .addColumn('queued_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('started_at', 'timestamptz')
    .addColumn('aggregate_started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable('knowledge_space_compile_run_pages')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('run_id', 'uuid', (col) =>
      col
        .notNull()
        .references('knowledge_space_compile_runs.id')
        .onDelete('cascade'),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    // Do not reference pages.id: a deletion during a run must still leave a
    // terminal barrier row that can be marked skipped.
    .addColumn('source_page_id', 'uuid', (col) => col.notNull())
    .addColumn('expected_source_version', 'varchar', (col) => col.notNull())
    .addColumn('expected_source_content_hash', 'varchar', (col) =>
      col.notNull(),
    )
    .addColumn('job_id', 'varchar')
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('pending'))
    .addColumn('error_code', 'varchar')
    .addColumn('error_message', 'varchar')
    .addColumn('queued_at', 'timestamptz')
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await sql`
    ALTER TABLE knowledge_space_compile_runs
      ADD CONSTRAINT chk_knowledge_space_compile_runs_status
      CHECK (status IN (
        'queued', 'compiling', 'aggregate_pending', 'aggregating',
        'succeeded', 'partial', 'failed', 'superseded'
      )),
      ADD CONSTRAINT chk_knowledge_space_compile_runs_counts
      CHECK (
        expected_page_count >= 0 AND succeeded_page_count >= 0 AND
        failed_page_count >= 0 AND skipped_page_count >= 0 AND
        succeeded_page_count + failed_page_count + skipped_page_count
          <= expected_page_count
      )
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_space_compile_run_pages
      ADD CONSTRAINT chk_knowledge_space_compile_run_pages_status
      CHECK (status IN (
        'pending', 'queued', 'running', 'succeeded', 'failed', 'skipped'
      ))
  `.execute(db);

  await db.schema
    .createIndex('uq_knowledge_space_compile_run_pages_run_page')
    .unique()
    .on('knowledge_space_compile_run_pages')
    .columns(['run_id', 'source_page_id'])
    .execute();
  await db.schema
    .createIndex('idx_knowledge_space_compile_runs_dispatch')
    .on('knowledge_space_compile_runs')
    .columns(['status', 'updated_at'])
    .execute();
  await db.schema
    .createIndex('idx_knowledge_space_compile_runs_diagnostics')
    .on('knowledge_space_compile_runs')
    .columns(['workspace_id', 'space_id', 'created_at'])
    .execute();
  await db.schema
    .createIndex('idx_knowledge_space_compile_run_pages_dispatch')
    .on('knowledge_space_compile_run_pages')
    .columns(['status', 'run_id', 'updated_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropTable('knowledge_space_compile_run_pages')
    .ifExists()
    .execute();
  await db.schema
    .dropTable('knowledge_space_compile_runs')
    .ifExists()
    .execute();
}
