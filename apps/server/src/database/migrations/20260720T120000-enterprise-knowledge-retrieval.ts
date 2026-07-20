import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE
      vector_version text;
    BEGIN
      SELECT extversion INTO vector_version
      FROM pg_extension
      WHERE extname = 'vector';

      IF vector_version IS NULL
        OR split_part(vector_version, '.', 1)::integer = 0
           AND split_part(vector_version, '.', 2)::integer < 8
      THEN
        RAISE EXCEPTION
          'Akasha enterprise retrieval requires pgvector 0.8.0 or newer';
      END IF;
    END $$
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_sources_acl
      ON knowledge_chunk_sources (workspace_id, chunk_id, source_page_id)
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_access_policy_fresh
      ON knowledge_source_access_policy (workspace_id, source_page_id)
      WHERE stale_at IS NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_access_principals_requirement
      ON knowledge_source_access_principals (
        workspace_id,
        source_page_id,
        requirement_id,
        principal_type,
        principal_id
      )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_active_channel
      ON knowledge_chunks (
        workspace_id,
        space_id,
        retrieval_channel,
        embedding_profile
      )
      WHERE stale_at IS NULL
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_pages_normalized_title
      ON knowledge_pages (
        workspace_id,
        space_id,
        (regexp_replace(lower(trim(title)), '\\s+', ' ', 'g')) text_pattern_ops
      )
      WHERE stale_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_knowledge_pages_normalized_title`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS idx_knowledge_chunks_active_channel`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS idx_knowledge_access_principals_requirement`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS idx_knowledge_access_policy_fresh`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_knowledge_chunk_sources_acl`.execute(db);
}
