import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('legacy_link_mappings')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('source', 'varchar', (col) => col.notNull())
    .addColumn('legacy_host', 'varchar')
    .addColumn('legacy_space_id', 'varchar')
    .addColumn('legacy_space_key', 'varchar')
    .addColumn('legacy_page_id', 'varchar')
    .addColumn('legacy_title', 'varchar')
    .addColumn('legacy_path', 'varchar')
    .addColumn('legacy_anchor', 'varchar')
    .addColumn('target_space_id', 'uuid', (col) =>
      col.references('spaces.id').onDelete('cascade'),
    )
    .addColumn('target_page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('cascade'),
    )
    .addColumn('target_attachment_id', 'uuid', (col) =>
      col.references('attachments.id').onDelete('cascade'),
    )
    .addColumn('target_url', 'varchar')
    .addColumn('import_task_id', 'uuid', (col) =>
      col.references('file_tasks.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('idx_legacy_link_mappings_workspace_source')
    .on('legacy_link_mappings')
    .columns(['workspace_id', 'source'])
    .execute();

  await db.schema
    .createIndex('idx_legacy_link_mappings_page_id')
    .on('legacy_link_mappings')
    .columns(['workspace_id', 'source', 'legacy_page_id'])
    .unique()
    .execute();

  await db.schema
    .createIndex('idx_legacy_link_mappings_space_title')
    .on('legacy_link_mappings')
    .columns(['workspace_id', 'source', 'legacy_space_key', 'legacy_title'])
    .execute();

  await db.schema
    .createIndex('idx_legacy_link_mappings_path')
    .on('legacy_link_mappings')
    .columns(['workspace_id', 'source', 'legacy_path'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('legacy_link_mappings').execute();
}
