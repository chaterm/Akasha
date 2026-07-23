import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';

export async function isKnowledgeVectorSearchReady(db: KyselyDB) {
  const result = await sql<{ ready: boolean }>`
    SELECT
      EXISTS (
        SELECT 1
        FROM pg_extension
        WHERE extname = 'vector'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = COALESCE(current_schema(), 'public')
          AND table_name = 'knowledge_chunks'
          AND column_name = 'embedding'
          AND udt_name = 'vector'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = COALESCE(current_schema(), 'public')
          AND table_name = 'knowledge_chunks'
          AND column_name = 'search_tsv'
      ) as ready
  `.execute(db);

  return result.rows[0]?.ready ?? false;
}

export async function tableExists(opts: {
  db: KyselyDB;
  tableName: string;
}): Promise<boolean> {
  const { db, tableName } = opts;
  const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = COALESCE(current_schema(), 'public')
        AND table_name = ${tableName}
      ) as exists
    `.execute(db);

  return result.rows[0]?.exists ?? false;
}
