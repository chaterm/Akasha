import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_pages')
    .addColumn('canonical_key', 'varchar')
    .execute();

  await sql`
    CREATE UNIQUE INDEX uq_knowledge_pages_canonical_key
      ON knowledge_pages (workspace_id, space_id, page_type, canonical_key)
      WHERE canonical_key IS NOT NULL
  `.execute(db);

  await db.schema
    .createTable('knowledge_compilation_attempts')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('source_page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('source_version', 'varchar')
    .addColumn('source_content_hash', 'varchar')
    .addColumn('status', 'varchar', (col) =>
      col.notNull().defaultTo('queued'),
    )
    .addColumn('stage', 'varchar', (col) =>
      col.notNull().defaultTo('queued'),
    )
    .addColumn('attempt_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('compiler_version', 'varchar', (col) => col.notNull())
    .addColumn('prompt_version', 'varchar', (col) => col.notNull())
    .addColumn('compiler_run_id', 'varchar')
    .addColumn('compile_task_id', 'varchar')
    .addColumn('error_code', 'varchar')
    .addColumn('error_message', 'varchar')
    .addColumn('last_successful_source_version', 'varchar')
    .addColumn('last_successful_source_hash', 'varchar')
    .addColumn('queued_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('started_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('last_succeeded_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('uq_knowledge_compilation_attempts_workspace_source')
    .unique()
    .on('knowledge_compilation_attempts')
    .columns(['workspace_id', 'source_page_id'])
    .execute();

  await db.schema
    .createIndex('idx_knowledge_compilation_attempts_diagnostics')
    .on('knowledge_compilation_attempts')
    .columns(['workspace_id', 'space_id', 'status', 'stage', 'updated_at'])
    .execute();

  await db.schema
    .createTable('knowledge_source_analyses')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('source_page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('source_version', 'varchar', (col) => col.notNull())
    .addColumn('source_content_hash', 'varchar', (col) => col.notNull())
    .addColumn('compiler_version', 'varchar', (col) => col.notNull())
    .addColumn('prompt_version', 'varchar', (col) => col.notNull())
    .addColumn('analysis', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('uq_knowledge_source_analyses_cache_key')
    .unique()
    .on('knowledge_source_analyses')
    .columns([
      'workspace_id',
      'source_page_id',
      'source_content_hash',
      'compiler_version',
      'prompt_version',
    ])
    .execute();

  await db.schema
    .createTable('knowledge_artifact_contributions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('source_page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('artifact_id', 'uuid', (col) => col.notNull())
    .addColumn('artifact_kind', 'varchar', (col) => col.notNull())
    .addColumn('canonical_key', 'varchar', (col) => col.notNull())
    .addColumn('source_version', 'varchar', (col) => col.notNull())
    .addColumn('source_content_hash', 'varchar', (col) => col.notNull())
    .addColumn('compiler_version', 'varchar', (col) => col.notNull())
    .addColumn('prompt_version', 'varchar', (col) => col.notNull())
    .addColumn('compiler_run_id', 'varchar', (col) => col.notNull())
    .addColumn('compile_task_id', 'varchar', (col) => col.notNull())
    .addColumn('artifact', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('uq_knowledge_artifact_contributions_source_artifact')
    .unique()
    .on('knowledge_artifact_contributions')
    .columns(['workspace_id', 'source_page_id', 'artifact_id'])
    .execute();

  await db.schema
    .createIndex('idx_knowledge_artifact_contributions_artifact')
    .on('knowledge_artifact_contributions')
    .columns(['workspace_id', 'space_id', 'artifact_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropTable('knowledge_artifact_contributions')
    .ifExists()
    .execute();
  await db.schema.dropTable('knowledge_source_analyses').ifExists().execute();
  await db.schema
    .dropTable('knowledge_compilation_attempts')
    .ifExists()
    .execute();
  await sql`DROP INDEX IF EXISTS uq_knowledge_pages_canonical_key`.execute(db);
  await db.schema
    .alterTable('knowledge_pages')
    .dropColumn('canonical_key')
    .execute();
}
