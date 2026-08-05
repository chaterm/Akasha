import { Kysely, sql } from 'kysely';

/**
 * Supports page-centric diagnostics and retry validation, both of which read
 * the most recently updated durable RunPage for each source page.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_run_pages_latest_source
      ON knowledge_space_compile_run_pages (
        workspace_id,
        source_page_id,
        updated_at DESC,
        id DESC
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS idx_knowledge_run_pages_latest_source
  `.execute(db);
}
