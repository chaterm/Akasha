import { Kysely } from 'kysely';

/**
 * Keeps validated/materialized page compiler output while required embeddings
 * are retried. The payload is not queried by retrieval and is cleared only
 * after the corresponding page publication succeeds (or a force reset).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_compilation_attempts')
    .addColumn('pending_import', 'jsonb')
    .addColumn('pending_space_id', 'uuid')
    .addColumn('pending_source_version', 'varchar')
    .addColumn('pending_effective_knowledge_hash', 'varchar')
    .addColumn('pending_created_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_compilation_attempts')
    .dropColumn('pending_created_at')
    .dropColumn('pending_effective_knowledge_hash')
    .dropColumn('pending_source_version')
    .dropColumn('pending_space_id')
    .dropColumn('pending_import')
    .execute();
}
