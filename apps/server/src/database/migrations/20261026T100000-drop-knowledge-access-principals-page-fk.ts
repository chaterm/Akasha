import { Kysely, sql } from 'kysely';

/**
 * knowledge_source_access_principals.source_page_id was never constrained by
 * the historical migrations: like the sibling access policy/requirement
 * tables, ACL rows may outlive their source page so lineage cleanup can run
 * later. The v1.0 baseline was dumped from a database that had the FK added
 * by hand, which breaks replay on production (orphaned rows already exist).
 * The baseline no longer adds it; this drops it where it was already applied.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_source_access_principals
      DROP CONSTRAINT IF EXISTS knowledge_source_access_principals_source_page_id_fkey
  `.execute(db);
}

// Re-adding the FK would fail on orphaned rows and contradicts the lineage
// design, so this migration is intentionally not reversed.
export async function down(_db: Kysely<unknown>): Promise<void> {}
