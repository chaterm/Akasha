import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_space_compile_runs')
    .addColumn('aggregate_required', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_space_compile_runs')
    .dropColumn('aggregate_required')
    .execute();
}
