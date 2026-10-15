// One-off backfill for knowledge_chunks.search_tsv_zh after migration
// 20261015T100000-knowledge-chunk-zh-search.
//
//   dev:  pnpm --filter ./apps/server backfill:zh-search
//   prod: node apps/server/dist/database/scripts/backfill-knowledge-chunk-zh-search.js
//
// Options (env): ZH_BACKFILL_BATCH_SIZE (default 2000), ZH_BACKFILL_PAUSE_MS (default 200)
import { Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
// `postgres` is CommonJS (`module.exports = Postgres`). This form resolves to
// the function both under tsx (dev) and in the compiled dist script, where the
// project builds without esModuleInterop.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- postgres is CommonJS in both tsx and the compiled script.
import postgres = require('postgres');
import * as dotenv from 'dotenv';
import { envPath, normalizePostgresUrl } from '../../common/helpers';
import { buildMigrationPostgresOptions } from '../database-postgres-options';
import { backfillKnowledgeChunkZhSearch } from './knowledge-chunk-zh-search-backfill';

dotenv.config({ path: envPath });

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const db = new Kysely<any>({
    dialect: new PostgresJSDialect({
      postgres: postgres(
        normalizePostgresUrl(process.env.DATABASE_URL),
        buildMigrationPostgresOptions(),
      ),
    }),
  });

  const startedAt = Date.now();
  try {
    const result = await backfillKnowledgeChunkZhSearch(db, {
      batchSize: Math.max(
        1,
        positiveInt(process.env.ZH_BACKFILL_BATCH_SIZE, 2000),
      ),
      pauseMs: positiveInt(process.env.ZH_BACKFILL_PAUSE_MS, 200),
      log: (message) => console.log(message),
    });
    console.log(
      `done: updated ${result.updatedRows} rows in ${result.batches} batches, ` +
        `${result.remainingRows} remaining, ${Date.now() - startedAt} ms`,
    );
    if (result.remainingRows > 0) process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
