import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    UPDATE knowledge_artifact_contributions
    SET artifact = artifact - 'graphEdges'
    WHERE artifact ? 'graphEdges'
  `.execute(db);
  await sql`DROP TABLE IF EXISTS knowledge_graph_edge_sources`.execute(db);
  await sql`DROP TABLE IF EXISTS knowledge_graph_edges`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
      id uuid DEFAULT gen_uuid_v7() NOT NULL PRIMARY KEY,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      from_knowledge_page_id uuid NOT NULL
        REFERENCES knowledge_pages(id) ON DELETE CASCADE,
      to_knowledge_page_id uuid
        REFERENCES knowledge_pages(id) ON DELETE CASCADE,
      relation text NOT NULL,
      compiler_run_id character varying,
      compile_task_id character varying,
      stale_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      target_artifact_kind character varying,
      target_canonical_key character varying,
      is_dangling boolean DEFAULT false NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS knowledge_graph_edge_sources (
      graph_edge_id uuid NOT NULL
        REFERENCES knowledge_graph_edges(id) ON DELETE CASCADE,
      source_page_id uuid NOT NULL,
      source_version character varying NOT NULL,
      source_range jsonb,
      quote_hash character varying,
      content_hash character varying NOT NULL,
      provenance_kind character varying NOT NULL,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_edges_workspace_space
      ON knowledge_graph_edges (workspace_id, space_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_canonical_target
      ON knowledge_graph_edges
        (workspace_id, space_id, target_artifact_kind, target_canonical_key)
      WHERE stale_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_from_page_fk
      ON knowledge_graph_edges (from_knowledge_page_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_to_page_fk
      ON knowledge_graph_edges (to_knowledge_page_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edge_sources_owner
      ON knowledge_graph_edge_sources (graph_edge_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edge_sources_source_page
      ON knowledge_graph_edge_sources (source_page_id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edge_sources_workspace_source
      ON knowledge_graph_edge_sources (workspace_id, source_page_id)
  `.execute(db);
}
