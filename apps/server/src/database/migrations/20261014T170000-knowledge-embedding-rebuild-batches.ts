import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('knowledge_embedding_rebuild_batches')
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
    .addColumn('chunk_count', 'integer', (col) => col.notNull())
    .addColumn('failed_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('total_tokens', 'integer', (col) => col)
    .addColumn('duration_ms', 'integer', (col) => col.notNull())
    .addColumn('embedding_profile', 'varchar(64)', (col) => col)
    .addColumn('embedding_model', 'varchar', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await sql`
    ALTER TABLE knowledge_embedding_rebuild_batches
      ADD CONSTRAINT knowledge_embedding_rebuild_batches_counts_check CHECK (
        chunk_count >= 0 AND
        failed_count >= 0 AND
        duration_ms >= 0 AND
        (total_tokens IS NULL OR total_tokens >= 0)
      )
  `.execute(db);

  await sql`
    CREATE INDEX idx_knowledge_embedding_rebuild_batches_scope
      ON knowledge_embedding_rebuild_batches
        (workspace_id, space_id, created_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_knowledge_embedding_rebuild_batches_scope
  `.execute(db);
  await db.schema
    .dropTable('knowledge_embedding_rebuild_batches')
    .ifExists()
    .execute();
}
