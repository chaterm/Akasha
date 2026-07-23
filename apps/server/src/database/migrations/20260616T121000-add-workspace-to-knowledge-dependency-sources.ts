import { type Kysely, sql } from 'kysely';

const dependencyTables = [
  {
    table: 'knowledge_page_sources',
    ownerColumn: 'knowledge_page_id',
    ownerTable: 'knowledge_pages',
  },
  {
    table: 'knowledge_claim_sources',
    ownerColumn: 'claim_id',
    ownerTable: 'knowledge_claims',
  },
  {
    table: 'knowledge_chunk_sources',
    ownerColumn: 'chunk_id',
    ownerTable: 'knowledge_chunks',
  },
  {
    table: 'knowledge_link_sources',
    ownerColumn: 'link_id',
    ownerTable: 'knowledge_links',
  },
  {
    table: 'knowledge_graph_edge_sources',
    ownerColumn: 'graph_edge_id',
    ownerTable: 'knowledge_graph_edges',
  },
] as const;

export async function up(db: Kysely<any>): Promise<void> {
  for (const dependency of dependencyTables) {
    await db.schema
      .alterTable(dependency.table)
      .addColumn('workspace_id', 'uuid', (col) =>
        col.references('workspaces.id').onDelete('cascade'),
      )
      .execute();

    await sql`
      UPDATE ${sql.table(dependency.table)} AS dependency
      SET workspace_id = owner.workspace_id
      FROM ${sql.table(dependency.ownerTable)} AS owner
      WHERE ${sql.ref(`dependency.${dependency.ownerColumn}`)} = owner.id
    `.execute(db);

    await sql`
      ALTER TABLE ${sql.table(dependency.table)}
      ALTER COLUMN workspace_id SET NOT NULL
    `.execute(db);

    await db.schema
      .createIndex(`idx_${dependency.table}_workspace_source`)
      .ifNotExists()
      .on(dependency.table)
      .columns(['workspace_id', 'source_page_id'])
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const dependency of [...dependencyTables].reverse()) {
    await db.schema
      .dropIndex(`idx_${dependency.table}_workspace_source`)
      .ifExists()
      .execute();

    await db.schema
      .alterTable(dependency.table)
      .dropColumn('workspace_id')
      .execute();
  }
}
