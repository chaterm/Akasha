import { type Kysely, sql } from 'kysely';

const SOURCE_PAGE_FOREIGN_KEYS = [
  ['knowledge_sources', 'knowledge_sources_source_page_id_fkey'],
  ['knowledge_source_chunks', 'knowledge_source_chunks_source_page_id_fkey'],
  ['knowledge_page_sources', 'knowledge_page_sources_source_page_id_fkey'],
  ['knowledge_claim_sources', 'knowledge_claim_sources_source_page_id_fkey'],
  ['knowledge_chunk_sources', 'knowledge_chunk_sources_source_page_id_fkey'],
  ['knowledge_link_sources', 'knowledge_link_sources_source_page_id_fkey'],
  [
    'knowledge_graph_edge_sources',
    'knowledge_graph_edge_sources_source_page_id_fkey',
  ],
  [
    'knowledge_source_access_policy',
    'knowledge_source_access_policy_source_page_id_fkey',
  ],
  [
    'knowledge_source_access_requirements',
    'knowledge_source_access_requirements_source_page_id_fkey',
  ],
] as const;

export async function up(db: Kysely<any>): Promise<void> {
  for (const [tableName, constraintName] of SOURCE_PAGE_FOREIGN_KEYS) {
    await sql
      .raw(
        `alter table if exists ${tableName} drop constraint if exists ${constraintName}`,
      )
      .execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const [tableName, constraintName] of SOURCE_PAGE_FOREIGN_KEYS) {
    await sql
      .raw(
        [
          `alter table if exists ${tableName}`,
          `add constraint ${constraintName}`,
          'foreign key (source_page_id)',
          'references pages(id)',
          'on delete cascade',
          'not valid',
        ].join(' '),
      )
      .execute(db);
  }
}
