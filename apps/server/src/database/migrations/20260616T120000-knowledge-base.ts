import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('knowledge_sources')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('source_type', 'varchar', (col) => col.notNull())
    .addColumn('source_page_id', 'uuid', (col) => col.notNull())
    .addColumn('source_space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('attachment_id', 'uuid', (col) =>
      col.references('attachments.id').onDelete('cascade'),
    )
    .addColumn('source_version', 'varchar', (col) => col.notNull())
    .addColumn('content_hash', 'varchar', (col) => col.notNull())
    .addColumn('mime_type', 'varchar', (col) => col)
    .addColumn('extracted_text', 'text', (col) => col)
    .addColumn('stale_at', 'timestamptz', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('deleted_at', 'timestamptz', (col) => col)
    .addUniqueConstraint('knowledge_sources_page_version_unique', [
      'workspace_id',
      'source_page_id',
      'source_version',
    ])
    .execute();

  await db.schema
    .createTable('knowledge_source_chunks')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('source_id', 'uuid', (col) =>
      col.notNull().references('knowledge_sources.id').onDelete('cascade'),
    )
    .addColumn('source_page_id', 'uuid', (col) => col.notNull())
    .addColumn('text', 'text', (col) => col.notNull())
    .addColumn('content_hash', 'varchar', (col) => col.notNull())
    .addColumn('source_range', 'jsonb', (col) => col)
    .addColumn('quote_hash', 'varchar', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable('knowledge_pages')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('compile_scope', 'varchar', (col) => col.notNull())
    .addColumn('title', 'varchar', (col) => col.notNull())
    .addColumn('slug', 'varchar', (col) => col.notNull())
    .addColumn('page_type', 'varchar', (col) => col)
    .addColumn('body', 'text', (col) => col.notNull())
    .addColumn('summary', 'text', (col) => col)
    .addColumn('compiled_at', 'timestamptz', (col) => col.notNull())
    .addColumn('compiler_version', 'varchar', (col) => col.notNull())
    .addColumn('compiler_run_id', 'varchar', (col) => col)
    .addColumn('compile_task_id', 'varchar', (col) => col)
    .addColumn('stale_at', 'timestamptz', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable('knowledge_claims')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('knowledge_page_id', 'uuid', (col) =>
      col.notNull().references('knowledge_pages.id').onDelete('cascade'),
    )
    .addColumn('text', 'text', (col) => col.notNull())
    .addColumn('confidence', 'float8', (col) => col)
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('compiler_run_id', 'varchar', (col) => col)
    .addColumn('compile_task_id', 'varchar', (col) => col)
    .addColumn('stale_at', 'timestamptz', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable('knowledge_chunks')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('knowledge_page_id', 'uuid', (col) =>
      col.notNull().references('knowledge_pages.id').onDelete('cascade'),
    )
    .addColumn('claim_id', 'uuid', (col) =>
      col.references('knowledge_claims.id').onDelete('cascade'),
    )
    .addColumn('text', 'text', (col) => col.notNull())
    .addColumn('content_hash', 'varchar', (col) => col.notNull())
    .addColumn('embedding', 'jsonb', (col) => col)
    .addColumn('compiler_run_id', 'varchar', (col) => col)
    .addColumn('compile_task_id', 'varchar', (col) => col)
    .addColumn('stale_at', 'timestamptz', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable('knowledge_links')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('from_knowledge_page_id', 'uuid', (col) =>
      col.notNull().references('knowledge_pages.id').onDelete('cascade'),
    )
    .addColumn('to_knowledge_page_id', 'uuid', (col) =>
      col.references('knowledge_pages.id').onDelete('set null'),
    )
    .addColumn('target_page_id', 'uuid', (col) =>
      col.references('pages.id').onDelete('set null'),
    )
    .addColumn('target_space_id', 'uuid', (col) =>
      col.references('spaces.id').onDelete('set null'),
    )
    .addColumn('link_text', 'text', (col) => col.notNull())
    .addColumn('link_type', 'varchar', (col) => col.notNull())
    .addColumn('is_dangling', 'boolean', (col) =>
      col.notNull().defaultTo(false),
    )
    .addColumn('compiler_run_id', 'varchar', (col) => col)
    .addColumn('compile_task_id', 'varchar', (col) => col)
    .addColumn('stale_at', 'timestamptz', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable('knowledge_graph_edges')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('from_knowledge_page_id', 'uuid', (col) =>
      col.notNull().references('knowledge_pages.id').onDelete('cascade'),
    )
    .addColumn('to_knowledge_page_id', 'uuid', (col) =>
      col.notNull().references('knowledge_pages.id').onDelete('cascade'),
    )
    .addColumn('relation', 'text', (col) => col.notNull())
    .addColumn('compiler_run_id', 'varchar', (col) => col)
    .addColumn('compile_task_id', 'varchar', (col) => col)
    .addColumn('stale_at', 'timestamptz', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await createDependencyTable(
    db,
    'knowledge_page_sources',
    'knowledge_page_id',
    'knowledge_pages',
  );
  await createDependencyTable(
    db,
    'knowledge_claim_sources',
    'claim_id',
    'knowledge_claims',
  );
  await createDependencyTable(
    db,
    'knowledge_chunk_sources',
    'chunk_id',
    'knowledge_chunks',
  );
  await createDependencyTable(
    db,
    'knowledge_link_sources',
    'link_id',
    'knowledge_links',
  );
  await createDependencyTable(
    db,
    'knowledge_graph_edge_sources',
    'graph_edge_id',
    'knowledge_graph_edges',
  );

  await db.schema
    .createTable('knowledge_source_access_policy')
    .ifNotExists()
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('source_page_id', 'uuid', (col) => col.notNull())
    .addColumn('source_space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('policy_hash', 'varchar', (col) => col.notNull())
    .addColumn('policy_version', 'integer', (col) =>
      col.notNull().defaultTo(1),
    )
    .addColumn('restricted_ancestor_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .addColumn('stale_at', 'timestamptz', (col) => col)
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('knowledge_source_access_policy_pk', [
      'workspace_id',
      'source_page_id',
    ])
    .execute();

  await db.schema
    .createTable('knowledge_source_access_requirements')
    .ifNotExists()
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('source_page_id', 'uuid', (col) => col.notNull())
    .addColumn('requirement_id', 'uuid', (col) => col.notNull())
    .addColumn('restricted_page_id', 'uuid', (col) =>
      col.notNull().references('pages.id').onDelete('cascade'),
    )
    .addColumn('depth', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('knowledge_source_access_requirements_pk', [
      'workspace_id',
      'source_page_id',
      'requirement_id',
    ])
    .execute();

  await db.schema
    .createTable('knowledge_source_access_principals')
    .ifNotExists()
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('source_page_id', 'uuid', (col) => col.notNull())
    .addColumn('requirement_id', 'uuid', (col) => col.notNull())
    .addColumn('principal_type', 'varchar', (col) => col.notNull())
    .addColumn('principal_id', 'uuid', (col) => col.notNull())
    .addColumn('role', 'varchar', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable('knowledge_query_audit')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.references('users.id').onDelete('set null'),
    )
    .addColumn('query_hash', 'varchar', (col) => col.notNull())
    .addColumn('retrieval_mode', 'varchar', (col) => col.notNull())
    .addColumn('authorized_capsule_count', 'integer', (col) => col.notNull())
    .addColumn('metadata', 'jsonb', (col) => col)
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await createIndexes(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('knowledge_query_audit').ifExists().execute();
  await db.schema
    .dropTable('knowledge_source_access_principals')
    .ifExists()
    .execute();
  await db.schema
    .dropTable('knowledge_source_access_requirements')
    .ifExists()
    .execute();
  await db.schema
    .dropTable('knowledge_source_access_policy')
    .ifExists()
    .execute();
  await db.schema
    .dropTable('knowledge_graph_edge_sources')
    .ifExists()
    .execute();
  await db.schema.dropTable('knowledge_link_sources').ifExists().execute();
  await db.schema.dropTable('knowledge_chunk_sources').ifExists().execute();
  await db.schema.dropTable('knowledge_claim_sources').ifExists().execute();
  await db.schema.dropTable('knowledge_page_sources').ifExists().execute();
  await db.schema.dropTable('knowledge_graph_edges').ifExists().execute();
  await db.schema.dropTable('knowledge_links').ifExists().execute();
  await db.schema.dropTable('knowledge_chunks').ifExists().execute();
  await db.schema.dropTable('knowledge_claims').ifExists().execute();
  await db.schema.dropTable('knowledge_pages').ifExists().execute();
  await db.schema.dropTable('knowledge_source_chunks').ifExists().execute();
  await db.schema.dropTable('knowledge_sources').ifExists().execute();
}

async function createDependencyTable(
  db: Kysely<any>,
  tableName: string,
  ownerColumn: string,
  ownerTable: string,
): Promise<void> {
  await db.schema
    .createTable(tableName)
    .ifNotExists()
    .addColumn(ownerColumn, 'uuid', (col) =>
      col.notNull().references(`${ownerTable}.id`).onDelete('cascade'),
    )
    .addColumn('source_page_id', 'uuid', (col) => col.notNull())
    .addColumn('attachment_id', 'uuid', (col) =>
      col.references('attachments.id').onDelete('cascade'),
    )
    .addColumn('source_version', 'varchar', (col) => col.notNull())
    .addColumn('source_range', 'jsonb', (col) => col)
    .addColumn('quote_hash', 'varchar', (col) => col)
    .addColumn('content_hash', 'varchar', (col) => col.notNull())
    .addColumn('provenance_kind', 'varchar', (col) => col.notNull())
    .execute();
}

async function createIndexes(db: Kysely<any>): Promise<void> {
  await db.schema
    .createIndex('idx_knowledge_sources_workspace_space')
    .ifNotExists()
    .on('knowledge_sources')
    .columns(['workspace_id', 'source_space_id'])
    .execute();

  await db.schema
    .createIndex('idx_knowledge_pages_workspace_space')
    .ifNotExists()
    .on('knowledge_pages')
    .columns(['workspace_id', 'space_id'])
    .execute();

  await db.schema
    .createIndex('idx_knowledge_chunks_workspace_space')
    .ifNotExists()
    .on('knowledge_chunks')
    .columns(['workspace_id', 'space_id'])
    .execute();

  await db.schema
    .createIndex('idx_knowledge_links_workspace_space')
    .ifNotExists()
    .on('knowledge_links')
    .columns(['workspace_id', 'space_id'])
    .execute();

  await db.schema
    .createIndex('idx_knowledge_edges_workspace_space')
    .ifNotExists()
    .on('knowledge_graph_edges')
    .columns(['workspace_id', 'space_id'])
    .execute();

  for (const [tableName, ownerColumn] of [
    ['knowledge_page_sources', 'knowledge_page_id'],
    ['knowledge_claim_sources', 'claim_id'],
    ['knowledge_chunk_sources', 'chunk_id'],
    ['knowledge_link_sources', 'link_id'],
    ['knowledge_graph_edge_sources', 'graph_edge_id'],
  ] as const) {
    await db.schema
      .createIndex(`idx_${tableName}_owner`)
      .ifNotExists()
      .on(tableName)
      .column(ownerColumn)
      .execute();

    await db.schema
      .createIndex(`idx_${tableName}_source_page`)
      .ifNotExists()
      .on(tableName)
      .column('source_page_id')
      .execute();
  }

  await db.schema
    .createIndex('idx_knowledge_access_policy_space')
    .ifNotExists()
    .on('knowledge_source_access_policy')
    .columns(['workspace_id', 'source_space_id'])
    .execute();

  await db.schema
    .createIndex('idx_knowledge_access_principals_lookup')
    .ifNotExists()
    .on('knowledge_source_access_principals')
    .columns(['workspace_id', 'principal_type', 'principal_id'])
    .execute();
}
