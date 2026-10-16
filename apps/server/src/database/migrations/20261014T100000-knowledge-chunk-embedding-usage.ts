import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_chunks')
    .addColumn('embedding_total_tokens', 'integer')
    .addColumn('embedding_duration_ms', 'integer')
    .execute();

  await sql`
    ALTER TABLE knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_embedding_usage_check CHECK (
        (embedding_total_tokens IS NULL OR embedding_total_tokens >= 0) AND
        (embedding_duration_ms IS NULL OR embedding_duration_ms >= 0)
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_chunks
      DROP CONSTRAINT IF EXISTS knowledge_chunks_embedding_usage_check
  `.execute(db);
  await db.schema
    .alterTable('knowledge_chunks')
    .dropColumn('embedding_duration_ms')
    .dropColumn('embedding_total_tokens')
    .execute();
}
