import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE knowledge_parent_sections (
      id uuid PRIMARY KEY DEFAULT gen_uuid_v7(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      knowledge_page_id uuid NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
      stable_key varchar(64) NOT NULL,
      heading_path jsonb NOT NULL DEFAULT '[]'::jsonb,
      text text NOT NULL,
      content_hash varchar(72) NOT NULL,
      start_offset integer,
      end_offset integer,
      stale_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, knowledge_page_id, stable_key),
      CONSTRAINT knowledge_parent_sections_range_check CHECK (
        (start_offset IS NULL AND end_offset IS NULL)
        OR (start_offset >= 0 AND end_offset > start_offset)
      )
    )
  `.execute(db);

  await sql`
    CREATE TABLE knowledge_parent_section_sources (
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      parent_section_id uuid NOT NULL REFERENCES knowledge_parent_sections(id) ON DELETE CASCADE,
      source_page_id uuid NOT NULL,
      source_version varchar NOT NULL,
      source_range jsonb,
      quote_hash varchar,
      content_hash varchar NOT NULL,
      provenance_kind varchar NOT NULL,
      attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (parent_section_id, source_page_id, source_version)
    )
  `.execute(db);

  await sql`
    ALTER TABLE knowledge_chunks
      ADD COLUMN parent_section_id uuid REFERENCES knowledge_parent_sections(id) ON DELETE CASCADE,
      ADD COLUMN stable_key varchar(64),
      ADD COLUMN chunk_role varchar(32) NOT NULL DEFAULT 'child',
      ADD COLUMN retrieval_channel varchar(32) NOT NULL DEFAULT 'memory',
      ADD COLUMN heading_path jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN start_offset integer,
      ADD COLUMN end_offset integer
  `.execute(db);
  await sql`
    UPDATE knowledge_chunks SET stable_key = id::text WHERE stable_key IS NULL
  `.execute(db);
  await sql`
    ALTER TABLE knowledge_chunks
      ALTER COLUMN stable_key SET NOT NULL,
      ADD CONSTRAINT knowledge_chunks_retrieval_channel_check
        CHECK (retrieval_channel IN ('evidence', 'memory')),
      ADD CONSTRAINT knowledge_chunks_role_check
        CHECK (chunk_role IN ('child', 'standalone')),
      ADD CONSTRAINT knowledge_chunks_range_check CHECK (
        (start_offset IS NULL AND end_offset IS NULL)
        OR (start_offset >= 0 AND end_offset > start_offset)
      ),
      ADD CONSTRAINT knowledge_chunks_stable_key_unique
        UNIQUE (workspace_id, knowledge_page_id, stable_key)
  `.execute(db);

  await sql`
    CREATE INDEX idx_knowledge_parent_sections_page
      ON knowledge_parent_sections (workspace_id, knowledge_page_id)
      WHERE stale_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX idx_knowledge_parent_section_sources_page
      ON knowledge_parent_section_sources (workspace_id, source_page_id)
  `.execute(db);
  await sql`
    CREATE INDEX idx_knowledge_chunks_channel
      ON knowledge_chunks (workspace_id, space_id, retrieval_channel)
      WHERE stale_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_knowledge_chunks_channel`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_knowledge_parent_section_sources_page`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS idx_knowledge_parent_sections_page`.execute(db);
  await sql`
    ALTER TABLE knowledge_chunks
      DROP CONSTRAINT IF EXISTS knowledge_chunks_stable_key_unique,
      DROP CONSTRAINT IF EXISTS knowledge_chunks_range_check,
      DROP CONSTRAINT IF EXISTS knowledge_chunks_role_check,
      DROP CONSTRAINT IF EXISTS knowledge_chunks_retrieval_channel_check,
      DROP COLUMN IF EXISTS end_offset,
      DROP COLUMN IF EXISTS start_offset,
      DROP COLUMN IF EXISTS heading_path,
      DROP COLUMN IF EXISTS retrieval_channel,
      DROP COLUMN IF EXISTS chunk_role,
      DROP COLUMN IF EXISTS stable_key,
      DROP COLUMN IF EXISTS parent_section_id
  `.execute(db);
  await sql`DROP TABLE IF EXISTS knowledge_parent_section_sources`.execute(db);
  await sql`DROP TABLE IF EXISTS knowledge_parent_sections`.execute(db);
}
