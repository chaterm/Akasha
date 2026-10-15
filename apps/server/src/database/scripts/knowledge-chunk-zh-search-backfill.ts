import { type Kysely, sql } from 'kysely';

export type ZhSearchBackfillOptions = {
  batchSize: number;
  pauseMs: number;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type ZhSearchBackfillResult = {
  updatedRows: number;
  batches: number;
  remainingRows: number;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function countPendingZhSearchRows(
  db: Kysely<any>,
): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count
    FROM knowledge_chunks
    WHERE search_tsv_zh IS NULL
  `.execute(db);
  return Number(result.rows[0]?.count ?? 0);
}

// Each batch is its own short statement, so the script can be interrupted
// and re-run; it only touches rows that are still missing search_tsv_zh.
// The UPDATE does not modify `text`, so the refresh trigger does not fire.
export async function backfillKnowledgeChunkZhSearch(
  db: Kysely<any>,
  options: ZhSearchBackfillOptions,
): Promise<ZhSearchBackfillResult> {
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? defaultSleep;
  let updatedRows = 0;
  let batches = 0;

  for (;;) {
    const result = await sql`
      UPDATE knowledge_chunks
      SET search_tsv_zh = to_tsvector('jiebaqry', coalesce(text, ''))
      WHERE id IN (
        SELECT id
        FROM knowledge_chunks
        WHERE search_tsv_zh IS NULL
        ORDER BY id
        LIMIT ${options.batchSize}
        FOR UPDATE SKIP LOCKED
      )
    `.execute(db);
    const affected = Number(result.numAffectedRows ?? 0);
    if (affected === 0) break;

    updatedRows += affected;
    batches += 1;
    log(`batch ${batches}: updated ${affected} rows (total ${updatedRows})`);
    if (options.pauseMs > 0) await sleep(options.pauseMs);
  }

  await sql`ANALYZE knowledge_chunks`.execute(db);
  const remainingRows = await countPendingZhSearchRows(db);
  return { updatedRows, batches, remainingRows };
}
