import { Kysely, sql } from 'kysely';

/**
 * Durable, page-level trailing-debounce schedule for automatic knowledge
 * compilation. A row remains here only while a create/update is waiting for
 * its quiet period; once due it is atomically promoted to a Space Run.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('knowledge_page_compile_schedules')
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
    .addColumn('trigger', 'varchar', (col) => col.notNull())
    .addColumn('change_count', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('first_changed_at', 'timestamptz', (col) => col.notNull())
    .addColumn('last_changed_at', 'timestamptz', (col) => col.notNull())
    .addColumn('eligible_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await sql`
    ALTER TABLE knowledge_page_compile_schedules
      ADD CONSTRAINT chk_knowledge_page_compile_schedules_trigger
      CHECK (trigger IN ('page_created', 'page_updated')),
      ADD CONSTRAINT chk_knowledge_page_compile_schedules_change_count
      CHECK (change_count >= 1),
      ADD CONSTRAINT chk_knowledge_page_compile_schedules_time_order
      CHECK (
        first_changed_at <= last_changed_at AND
        last_changed_at <= eligible_at
      )
  `.execute(db);

  await db.schema
    .createIndex('uq_knowledge_page_compile_schedules_workspace_page')
    .unique()
    .on('knowledge_page_compile_schedules')
    .columns(['workspace_id', 'source_page_id'])
    .execute();
  await db.schema
    .createIndex('idx_knowledge_page_compile_schedules_due')
    .on('knowledge_page_compile_schedules')
    .columns(['eligible_at', 'id'])
    .execute();
  await db.schema
    .createIndex('idx_knowledge_page_compile_schedules_scope')
    .on('knowledge_page_compile_schedules')
    .columns(['workspace_id', 'space_id', 'eligible_at'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropTable('knowledge_page_compile_schedules')
    .ifExists()
    .execute();
}
