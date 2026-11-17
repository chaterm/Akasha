import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS embedding_legacy
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_legacy jsonb
  `.execute(db);
}
