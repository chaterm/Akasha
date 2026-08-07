import { Kysely, sql } from 'kysely';

/**
 * Separates cheap page discovery from the exact source snapshot captured by a
 * worker. Existing RunPages are already bound; only newly initialized Runs use
 * the explicit unbound -> binding -> bound lifecycle.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_space_compile_run_pages')
    .addColumn('binding_status', 'varchar', (col) =>
      col.notNull().defaultTo('bound'),
    )
    .addColumn('discovered_source_version', 'timestamptz')
    .addColumn('bound_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .addColumn('quality_status', 'varchar', (col) =>
      col.notNull().defaultTo('normal'),
    )
    .addColumn('reused', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();

  await db.schema
    .alterTable('knowledge_space_compile_run_pages')
    .alterColumn('expected_source_version', (col) => col.dropNotNull())
    .alterColumn('expected_source_content_hash', (col) => col.dropNotNull())
    .alterColumn('expected_image_count', (col) => col.dropNotNull())
    .execute();

  await sql`
    ALTER TABLE knowledge_space_compile_run_pages
      ADD CONSTRAINT chk_knowledge_space_compile_run_pages_binding_status
      CHECK (binding_status IN ('unbound', 'binding', 'bound')),
      ADD CONSTRAINT chk_knowledge_space_compile_run_pages_quality_status
      CHECK (quality_status IN ('normal', 'degraded', 'partial_image')),
      ADD CONSTRAINT chk_knowledge_space_compile_run_pages_binding
      CHECK (
        (
          binding_status IN ('unbound', 'binding') AND
          expected_source_version IS NULL AND
          expected_source_content_hash IS NULL AND
          expected_image_count IS NULL AND
          bound_at IS NULL
        ) OR (
          binding_status = 'bound' AND
          expected_source_version IS NOT NULL AND
          expected_source_content_hash IS NOT NULL AND
          expected_image_count IS NOT NULL AND
          bound_at IS NOT NULL
        )
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_space_compile_run_pages
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_run_pages_binding,
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_run_pages_quality_status,
      DROP CONSTRAINT IF EXISTS
        chk_knowledge_space_compile_run_pages_binding_status
  `.execute(db);

  // A rollback cannot restore NOT NULL while an active unbound Run exists.
  // Fail safely instead of deleting or fabricating source identities.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM knowledge_space_compile_run_pages
        WHERE expected_source_version IS NULL
           OR expected_source_content_hash IS NULL
           OR expected_image_count IS NULL
      ) THEN
        RAISE EXCEPTION
          'Cannot roll back RunPage binding migration while unbound rows exist';
      END IF;
    END
    $$
  `.execute(db);

  await db.schema
    .alterTable('knowledge_space_compile_run_pages')
    .alterColumn('expected_source_version', (col) => col.setNotNull())
    .alterColumn('expected_source_content_hash', (col) => col.setNotNull())
    .alterColumn('expected_image_count', (col) => col.setNotNull())
    .dropColumn('reused')
    .dropColumn('quality_status')
    .dropColumn('bound_at')
    .dropColumn('discovered_source_version')
    .dropColumn('binding_status')
    .execute();
}
