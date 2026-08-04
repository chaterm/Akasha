import { Kysely, sql } from 'kysely';

/**
 * PostgreSQL does not create indexes for the referencing side of a foreign key.
 * Force rebuild deletes knowledge_pages and relies on cascades through these
 * columns. Without the indexes, every deleted parent row can scan an entire
 * child table, which makes cleanup quadratic for large legacy knowledge sets.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of [
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_claims_page_fk
        ON knowledge_claims (knowledge_page_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_page_fk
        ON knowledge_chunks (knowledge_page_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_claim_fk
        ON knowledge_chunks (claim_id)
        WHERE claim_id IS NOT NULL`,
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_parent_section_fk
        ON knowledge_chunks (parent_section_id)
        WHERE parent_section_id IS NOT NULL`,
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_links_from_page_fk
        ON knowledge_links (from_knowledge_page_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_links_to_page_fk
        ON knowledge_links (to_knowledge_page_id)
        WHERE to_knowledge_page_id IS NOT NULL`,
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_from_page_fk
        ON knowledge_graph_edges (from_knowledge_page_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_to_page_fk
        ON knowledge_graph_edges (to_knowledge_page_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_knowledge_parent_sections_page_fk
        ON knowledge_parent_sections (knowledge_page_id)`,
  ]) {
    await statement.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const indexName of [
    'idx_knowledge_parent_sections_page_fk',
    'idx_knowledge_graph_edges_to_page_fk',
    'idx_knowledge_graph_edges_from_page_fk',
    'idx_knowledge_links_to_page_fk',
    'idx_knowledge_links_from_page_fk',
    'idx_knowledge_chunks_parent_section_fk',
    'idx_knowledge_chunks_claim_fk',
    'idx_knowledge_chunks_page_fk',
    'idx_knowledge_claims_page_fk',
  ]) {
    await sql`DROP INDEX IF EXISTS ${sql.id(indexName)}`.execute(db);
  }
}
