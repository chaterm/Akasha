import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // The extension is intentionally retained. Dropping it becomes destructive
  // as soon as a later migration adds vector columns or indexes.
}
