import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('knowledge_page_index_settings')
    .ifNotExists()
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('source_page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('index_mode', 'varchar(32)', (col) =>
      col.notNull().defaultTo('compiled'),
    )
    .addColumn('updated_by', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('knowledge_page_index_settings_pk', [
      'workspace_id',
      'source_page_id',
    ])
    .execute();

  await sql`
    ALTER TABLE knowledge_page_index_settings
      DROP CONSTRAINT IF EXISTS knowledge_page_index_settings_mode_check,
      ADD CONSTRAINT knowledge_page_index_settings_mode_check
      CHECK (index_mode IN ('compiled', 'original'))
  `.execute(db);

  await db.schema
    .alterTable('knowledge_space_compile_run_pages')
    .addColumn('index_mode', 'varchar(32)', (col) =>
      col.notNull().defaultTo('compiled'),
    )
    .execute();
  await sql`
    ALTER TABLE knowledge_space_compile_run_pages
      ADD CONSTRAINT knowledge_space_compile_run_pages_index_mode_check
      CHECK (index_mode IN ('compiled', 'original'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_space_compile_run_pages
      DROP CONSTRAINT IF EXISTS knowledge_space_compile_run_pages_index_mode_check
  `.execute(db);
  await db.schema
    .alterTable('knowledge_space_compile_run_pages')
    .dropColumn('index_mode')
    .execute();
  await db.schema
    .dropTable('knowledge_page_index_settings')
    .ifExists()
    .execute();
}
