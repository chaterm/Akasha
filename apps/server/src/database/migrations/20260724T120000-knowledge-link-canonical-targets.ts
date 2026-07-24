import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_links')
    .addColumn('target_artifact_kind', 'varchar')
    .addColumn('target_canonical_key', 'varchar')
    .execute();

  await sql`
    CREATE INDEX idx_knowledge_links_canonical_target
      ON knowledge_links (
        workspace_id,
        space_id,
        target_artifact_kind,
        target_canonical_key
      )
      WHERE stale_at IS NULL AND is_dangling = true
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_knowledge_links_canonical_target`.execute(
    db,
  );
  await db.schema
    .alterTable('knowledge_links')
    .dropColumn('target_canonical_key')
    .dropColumn('target_artifact_kind')
    .execute();
}
