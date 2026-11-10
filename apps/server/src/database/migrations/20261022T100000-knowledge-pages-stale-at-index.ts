import { Kysely, sql } from 'kysely';

/**
 * Supports the daily stale-artifact purge, which scans retired KnowledgePages
 * oldest first. Active rows (stale_at IS NULL) are the vast majority and are
 * excluded so the index only tracks purge candidates.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_pages_stale_at
      ON knowledge_pages (stale_at)
      WHERE stale_at IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_knowledge_pages_stale_at`.execute(db);
}
