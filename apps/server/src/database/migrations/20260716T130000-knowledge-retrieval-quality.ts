import { Kysely, sql } from 'kysely';

/**
 * Compatibility migration for the first pgvector retrieval experiment.
 *
 * This migration has already shipped to development databases. Keep it in the
 * migration chain so those databases remain upgradeable; the later native
 * retrieval migration replaces the temporary embedding_vector column with the
 * dimension/profile-aware schema.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  await sql`
    ALTER TABLE knowledge_pages
      ADD COLUMN generation_mode varchar(32) NOT NULL DEFAULT 'legacy'
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_chunks
      ADD COLUMN embedding_vector vector
  `.execute(db);
  await sql`
    UPDATE knowledge_chunks
    SET embedding_vector = embedding::text::vector
    WHERE embedding IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX knowledge_chunks_embedding_vector_hnsw_idx
      ON knowledge_chunks USING hnsw (embedding_vector vector_cosine_ops)
      WHERE stale_at IS NULL AND embedding_vector IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX knowledge_chunks_text_trgm_idx
      ON knowledge_chunks USING GIN (text gin_trgm_ops)
      WHERE stale_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX knowledge_pages_title_trgm_idx
      ON knowledge_pages USING GIN (title gin_trgm_ops)
      WHERE stale_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX knowledge_pages_retrieval_mode_idx
      ON knowledge_pages (workspace_id, space_id, page_type, generation_mode)
      WHERE stale_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS knowledge_pages_retrieval_mode_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS knowledge_pages_title_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS knowledge_chunks_text_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS knowledge_chunks_embedding_vector_hnsw_idx`.execute(
    db,
  );
  await sql`
    ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS embedding_vector
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_pages DROP COLUMN IF EXISTS generation_mode
  `.execute(db);
}
