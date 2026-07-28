import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_space_compile_run_pages')
    .addColumn('skipped_image_count', 'integer', (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();
  await sql`
    ALTER TABLE knowledge_space_compile_run_pages
      DROP CONSTRAINT chk_knowledge_space_compile_run_pages_image_counts,
      ADD CONSTRAINT chk_knowledge_space_compile_run_pages_image_counts
      CHECK (
        expected_image_count >= 0 AND
        succeeded_image_count >= 0 AND
        failed_image_count >= 0 AND
        skipped_image_count >= 0 AND
        succeeded_image_count + failed_image_count + skipped_image_count
          <= expected_image_count
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_space_compile_run_pages
      DROP CONSTRAINT chk_knowledge_space_compile_run_pages_image_counts,
      ADD CONSTRAINT chk_knowledge_space_compile_run_pages_image_counts
      CHECK (
        expected_image_count >= 0 AND
        succeeded_image_count >= 0 AND
        failed_image_count >= 0 AND
        succeeded_image_count + failed_image_count <= expected_image_count
      )
  `.execute(db);
  await db.schema
    .alterTable('knowledge_space_compile_run_pages')
    .dropColumn('skipped_image_count')
    .execute();
}
