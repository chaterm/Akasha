import { Kysely } from 'kysely';

/**
 * Adds an optional page scope to Space compile Runs. A NULL value preserves the
 * existing full-Space behavior; a non-null JSON array of source page IDs marks a
 * page-scoped Run that must compile only those pages (see initializeLeasedRun).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_space_compile_runs')
    .addColumn('target_source_page_ids', 'jsonb')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_space_compile_runs')
    .dropColumn('target_source_page_ids')
    .execute();
}
