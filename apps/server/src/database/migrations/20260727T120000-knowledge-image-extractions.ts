import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('knowledge_image_extractions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('attachment_id', 'uuid', (col) =>
      col.notNull().references('attachments.id').onDelete('cascade'),
    )
    .addColumn('content_hash', 'varchar', (col) => col.notNull())
    .addColumn('model', 'varchar', (col) => col.notNull())
    .addColumn('prompt_version', 'varchar', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('mime_type', 'varchar')
    .addColumn('file_name', 'varchar')
    .addColumn('ocr_text', 'text')
    .addColumn('caption', 'text')
    .addColumn('error_code', 'varchar')
    .addColumn('error_message', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('knowledge_image_extractions_cache_key_unique', [
      'workspace_id',
      'attachment_id',
      'content_hash',
      'model',
      'prompt_version',
    ])
    .addCheckConstraint(
      'knowledge_image_extractions_status_check',
      sql`status IN ('ready', 'failed')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('knowledge_image_extractions').ifExists().execute();
}
