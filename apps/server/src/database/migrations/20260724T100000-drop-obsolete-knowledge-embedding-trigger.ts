import { Kysely, sql } from 'kysely';

/**
 * Older installations can still contain the temporary JSONB-to-vector trigger
 * created while pgvector rollout was in progress. The native retrieval
 * migration renamed the JSONB column and removed embedding_vector, so that
 * trigger now calls jsonb_typeof on the native vector column and makes every
 * semantic chunk insert fail.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS knowledge_chunks_sync_embedding_vector_trigger
      ON knowledge_chunks
  `.execute(db);
  await sql`
    DROP FUNCTION IF EXISTS knowledge_chunks_sync_embedding_vector()
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Intentionally irreversible: the removed function references the retired
  // embedding_vector column and is invalid against the current schema.
}
