import { Kysely, sql } from 'kysely';

/**
 * embedding_legacy duplicated every chunk vector as jsonb after the pgvector
 * `embedding` column became canonical. Nothing reads it, and it was ~70% of
 * knowledge_chunks row bytes. Dropping is metadata-only; reclaiming the disk
 * space requires a table rewrite (pg_repack / VACUUM FULL) run separately.
 *
 * Must ship after the release that stopped writing the column, otherwise
 * instances still on the old code fail their inserts during a rolling deploy.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // DROP COLUMN needs a brief ACCESS EXCLUSIVE lock. Fail fast instead of
  // queueing every chunk read behind a long-running transaction; a redeploy
  // retries the migration.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await sql`
    ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS embedding_legacy
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restores the column shape only; the dropped values are not recoverable
  // and no code path reads them.
  await sql`
    ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_legacy jsonb
  `.execute(db);
}
