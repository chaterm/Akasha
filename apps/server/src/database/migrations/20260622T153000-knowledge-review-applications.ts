import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('knowledge_review_applications')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('review_item_id', 'varchar', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull().defaultTo('draft'))
    .addColumn('operation', 'varchar', (col) => col.notNull())
    .addColumn('target_page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('set null'),
    )
    .addColumn('target_page_title', 'text')
    .addColumn('target_heading_path', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn('base_page_version', 'varchar')
    .addColumn('base_content_hash', 'varchar')
    .addColumn('before_content', 'text')
    .addColumn('after_content', 'text', (col) => col.notNull())
    .addColumn('after_content_hash', 'varchar', (col) => col.notNull())
    .addColumn('patch', 'jsonb')
    .addColumn('created_page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('set null'),
    )
    .addColumn('applied_at', 'timestamptz')
    .addColumn('reverted_at', 'timestamptz')
    .addColumn('applied_by', 'uuid', (col) =>
      col.notNull().references('users.id'),
    )
    .addColumn('rationale', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('source_refs', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('idx_knowledge_review_applications_space_item_updated')
    .ifNotExists()
    .on('knowledge_review_applications')
    .columns(['workspace_id', 'space_id', 'review_item_id', 'updated_at'])
    .execute();

  await db.schema
    .createIndex('idx_knowledge_review_applications_status')
    .ifNotExists()
    .on('knowledge_review_applications')
    .columns(['workspace_id', 'status'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropTable('knowledge_review_applications')
    .ifExists()
    .execute();
}
