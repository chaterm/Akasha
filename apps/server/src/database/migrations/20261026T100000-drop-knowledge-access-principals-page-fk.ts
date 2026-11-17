import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_source_access_principals
      DROP CONSTRAINT IF EXISTS knowledge_source_access_principals_source_page_id_fkey
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {}
