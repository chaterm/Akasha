import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('knowledge_quarantined_artifacts')
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
    .addColumn('artifact_id', 'varchar', (col) => col)
    .addColumn('artifact_kind', 'varchar', (col) => col)
    .addColumn('compiler_run_id', 'varchar', (col) => col)
    .addColumn('compile_task_id', 'varchar', (col) => col)
    .addColumn('reason_codes', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('idx_knowledge_quarantined_artifacts_workspace_created')
    .ifNotExists()
    .on('knowledge_quarantined_artifacts')
    .columns(['workspace_id', 'created_at'])
    .execute();

  await db.schema
    .createIndex('idx_knowledge_quarantined_artifacts_space_created')
    .ifNotExists()
    .on('knowledge_quarantined_artifacts')
    .columns(['workspace_id', 'space_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropTable('knowledge_quarantined_artifacts')
    .ifExists()
    .execute();
}
