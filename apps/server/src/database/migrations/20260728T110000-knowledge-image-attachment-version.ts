import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_image_extractions')
    .addColumn('attachment_version', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('knowledge_image_extractions')
    .dropColumn('attachment_version')
    .execute();
}
