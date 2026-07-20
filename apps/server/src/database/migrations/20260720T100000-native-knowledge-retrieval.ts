import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);

  await sql`
    ALTER TABLE knowledge_chunks
      RENAME COLUMN embedding TO embedding_legacy
  `.execute(db);

  await sql`
    ALTER TABLE knowledge_chunks
      ADD COLUMN embedding vector,
      ADD COLUMN embedding_profile varchar(64),
      ADD COLUMN embedding_model varchar(255),
      ADD COLUMN embedding_dimensions integer,
      ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS
        (to_tsvector('simple', coalesce(text, ''))) STORED
  `.execute(db);

  // Preserve vectors produced by the earlier compatibility migration. Their
  // provider identity was not recorded, so use an explicit legacy profile;
  // new imports will write a stable provider-specific profile.
  await sql`
    UPDATE knowledge_chunks
    SET
      embedding = embedding_vector,
      embedding_profile = repeat('0', 64),
      embedding_model = 'legacy-jsonb',
      embedding_dimensions = vector_dims(embedding_vector)
    WHERE embedding_vector IS NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE knowledge_chunks
      ADD CONSTRAINT knowledge_chunks_embedding_metadata_check CHECK (
        (
          embedding IS NULL
          AND embedding_profile IS NULL
          AND embedding_model IS NULL
          AND embedding_dimensions IS NULL
        )
        OR
        (
          embedding IS NOT NULL
          AND embedding_profile IS NOT NULL
          AND embedding_model IS NOT NULL
          AND embedding_dimensions > 0
          AND vector_dims(embedding) = embedding_dimensions
        )
      )
  `.execute(db);

  await sql`
    CREATE INDEX idx_knowledge_chunks_search_tsv
      ON knowledge_chunks USING GIN (search_tsv)
  `.execute(db);

  await sql`
    CREATE INDEX idx_knowledge_chunks_embedding_profile
      ON knowledge_chunks (workspace_id, space_id, embedding_profile)
      WHERE stale_at IS NULL AND embedding IS NOT NULL
  `.execute(db);

  await sql`DROP INDEX IF EXISTS knowledge_chunks_embedding_vector_hnsw_idx`.execute(
    db,
  );
  await sql`
    ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS embedding_vector
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_chunks ADD COLUMN embedding_vector vector
  `.execute(db);
  await sql`
    UPDATE knowledge_chunks
    SET embedding_vector = embedding
    WHERE embedding IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX knowledge_chunks_embedding_vector_hnsw_idx
      ON knowledge_chunks USING hnsw (embedding_vector vector_cosine_ops)
      WHERE stale_at IS NULL AND embedding_vector IS NOT NULL
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_knowledge_chunks_embedding_profile`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS idx_knowledge_chunks_search_tsv`.execute(db);
  await sql`
    ALTER TABLE knowledge_chunks
      DROP CONSTRAINT IF EXISTS knowledge_chunks_embedding_metadata_check,
      DROP COLUMN IF EXISTS search_tsv,
      DROP COLUMN IF EXISTS embedding_dimensions,
      DROP COLUMN IF EXISTS embedding_model,
      DROP COLUMN IF EXISTS embedding_profile,
      DROP COLUMN IF EXISTS embedding
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_chunks
      RENAME COLUMN embedding_legacy TO embedding
  `.execute(db);
}
