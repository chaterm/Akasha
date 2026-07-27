import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_source_chunks_page
      ON knowledge_source_chunks (
        workspace_id, source_page_id, created_at DESC
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_knowledge_source_chunks_page`.execute(db);
}
