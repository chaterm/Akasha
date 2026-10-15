import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import { backfillKnowledgeChunkZhSearch } from './scripts/knowledge-chunk-zh-search-backfill';

describe('knowledge chunk Chinese search migration', () => {
  async function source() {
    return (
      await readFile(
        resolve(
          __dirname,
          'migrations/20261015T100000-knowledge-chunk-zh-search.ts',
        ),
        'utf8',
      )
    ).replace(/\s+/g, ' ');
  }

  it('adds a trigger-maintained column instead of rewriting the table', async () => {
    const sql = await source();

    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_jieba');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS search_tsv_zh tsvector');
    expect(sql).not.toContain('GENERATED ALWAYS');
    expect(sql).toContain(
      'BEFORE INSERT OR UPDATE OF text ON knowledge_chunks',
    );
    expect(sql).toContain("to_tsvector('jiebaqry'");
    expect(sql).toContain('USING GIN (search_tsv_zh)');
    // CONCURRENTLY cannot run inside the migration transaction.
    expect(sql).not.toContain('CONCURRENTLY');
  });

  it('segments queries once with jiebacfg and drops punctuation lexemes', async () => {
    const sql = await source();

    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION knowledge_zh_query_terms(query text) RETURNS tsquery[]',
    );
    expect(sql).toContain("to_tsvector('jiebacfg'");
    expect(sql).toContain('[[:space:][:punct:]');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION knowledge_zh_tsquery(');
    expect(sql).toContain('match_all boolean DEFAULT false');
    expect(sql).toContain(
      'FROM unnest(knowledge_zh_query_terms(query)) AS term',
    );
    expect(sql).toContain("CASE WHEN match_all THEN ' & ' ELSE ' | ' END");
  });

  it('keeps pg_jieba installed on rollback', async () => {
    const sql = await source();
    const down = sql.slice(sql.indexOf('export async function down'));

    expect(down).toContain('DROP COLUMN IF EXISTS search_tsv_zh');
    expect(down).not.toContain('DROP EXTENSION');
  });
});

describe('backfillKnowledgeChunkZhSearch', () => {
  function createDb(affectedPerBatch: number[], pending = 0) {
    const statements: string[] = [];
    const connection = {
      executeQuery: async (query: {
        sql: string;
      }): Promise<QueryResult<any>> => {
        statements.push(query.sql.replace(/\s+/g, ' ').trim());
        if (query.sql.includes('UPDATE knowledge_chunks')) {
          return {
            rows: [],
            numAffectedRows: BigInt(affectedPerBatch.shift() ?? 0),
          };
        }
        if (query.sql.includes('count(*)'))
          return { rows: [{ count: pending }] };
        return { rows: [] };
      },
      streamQuery: () => {
        throw new Error('not supported');
      },
    };
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => ({
          init: async () => {},
          acquireConnection: async () => connection,
          beginTransaction: async () => {},
          commitTransaction: async () => {},
          rollbackTransaction: async () => {},
          releaseConnection: async () => {},
          destroy: async () => {},
        }),
        createIntrospector: (instance) => new PostgresIntrospector(instance),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    return { db, statements };
  }

  it('updates pending rows in batches until none remain, then analyzes', async () => {
    const { db, statements } = createDb([2, 2, 1]);
    const sleep = jest.fn(async () => {});

    const result = await backfillKnowledgeChunkZhSearch(db, {
      batchSize: 2,
      pauseMs: 50,
      sleep,
    });

    expect(result).toEqual({ updatedRows: 5, batches: 3, remainingRows: 0 });
    expect(sleep).toHaveBeenCalledTimes(3);
    const updates = statements.filter((s) => s.startsWith('UPDATE'));
    expect(updates).toHaveLength(4);
    expect(updates[0]).toContain("to_tsvector('jiebaqry', coalesce(text, ''))");
    expect(updates[0]).toContain('WHERE search_tsv_zh IS NULL');
    expect(updates[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(statements).toContain('ANALYZE knowledge_chunks');
  });

  it('is a no-op when everything is already backfilled', async () => {
    const { db } = createDb([0]);

    await expect(
      backfillKnowledgeChunkZhSearch(db, { batchSize: 2000, pauseMs: 0 }),
    ).resolves.toEqual({ updatedRows: 0, batches: 0, remainingRows: 0 });
  });
});
