import { type Kysely, sql } from 'kysely';

// `simple` full-text search does not segment Han text, so Chinese lexical
// recall was effectively empty. Add a jieba-segmented tsvector next to the
// legacy `search_tsv`.
//
// The column is a plain nullable column maintained by a trigger rather than
// GENERATED STORED: a stored generated column rewrites the whole table
// (including TOASTed embeddings) under an ACCESS EXCLUSIVE lock. Existing rows
// are backfilled in batches by scripts/backfill-knowledge-chunk-zh-search.ts.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_jieba`.execute(db);

  await sql`
    ALTER TABLE knowledge_chunks
      ADD COLUMN IF NOT EXISTS search_tsv_zh tsvector
  `.execute(db);

  // Documents use the search-engine mode so compound words also index their
  // sub-words (本合同 -> 本合同, 合同), matching queries segmented in exact mode.
  await sql`
    CREATE OR REPLACE FUNCTION knowledge_chunks_search_tsv_zh_refresh()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.search_tsv_zh := to_tsvector('jiebaqry', coalesce(NEW.text, ''));
      RETURN NEW;
    END;
    $$
  `.execute(db);

  await sql`
    DROP TRIGGER IF EXISTS knowledge_chunks_search_tsv_zh_refresh
      ON knowledge_chunks
  `.execute(db);
  await sql`
    CREATE TRIGGER knowledge_chunks_search_tsv_zh_refresh
      BEFORE INSERT OR UPDATE OF text ON knowledge_chunks
      FOR EACH ROW
      EXECUTE FUNCTION knowledge_chunks_search_tsv_zh_refresh()
  `.execute(db);

  // The column is empty at this point, so a regular (non-concurrent) build is
  // instant and can run inside the migration transaction.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_search_tsv_zh
      ON knowledge_chunks USING GIN (search_tsv_zh)
  `.execute(db);

  // Query segmentation lives in one function so the OR query and the
  // per-term coverage check (minimum-should-match) always agree.
  // jieba emits whitespace/punctuation as lexemes (' ', '—', '，'); drop them so
  // they neither match nearly every chunk (OR) nor block matches (AND). Under
  // the C locale [[:punct:]] only covers ASCII, hence the Unicode ranges.
  // jieba's stopword list also misses conversational filler ("请问X在哪里" ->
  // 请问, X). Left in, a filler word counts as a required term and the topic
  // term alone no longer clears minimum-should-match; drop it at query time
  // only (documents keep every lexeme).
  await sql`
    CREATE OR REPLACE FUNCTION knowledge_zh_query_terms(query text)
    RETURNS tsquery[]
    LANGUAGE sql
    STABLE
    PARALLEL SAFE
    AS $$
      SELECT coalesce(
               array_agg(
                 ('''' || replace(replace(lexeme, '\\', '\\\\'), '''', '''''') || '''')::tsquery
                 ORDER BY lexeme
               ),
               '{}'
             )
      FROM unnest(tsvector_to_array(to_tsvector('jiebacfg', coalesce(query, '')))) AS lexeme
      WHERE lexeme !~ '^[[:space:][:punct:]\\u00A0-\\u00BF\\u2000-\\u206F\\u3000-\\u303F\\uFE30-\\uFE4F\\uFF00-\\uFF0F\\uFF1A-\\uFF20\\uFF3B-\\uFF40\\uFF5B-\\uFF65]+$'
        AND lexeme <> ALL (ARRAY[
          '请问', '麻烦', '帮', '帮忙', '帮我', '我查', '一下', '告诉', '想', '想要',
          '了解', '介绍', '能不能', '不能', '可以', '能否', '是否', '应该', '需要',
          '怎么回事', '怎样才能', '干什么', '什么', '什么样', '哪些', '哪里', '哪个',
          '如何', '怎么', '怎么办', '怎样', '为什么', '为何', '是不是', '有没有',
          '具体', '意思', '指', '情况', '相关', '关于', '内容', '说明', '一些', '有关'
        ])
    $$
  `.execute(db);

  // OR (default) for natural-language questions, which rarely contain every
  // term; match_all = true ANDs them for short entity/title signals.
  // Returns NULL when the query has no searchable terms.
  await sql`
    CREATE OR REPLACE FUNCTION knowledge_zh_tsquery(
      query text,
      match_all boolean DEFAULT false
    )
    RETURNS tsquery
    LANGUAGE sql
    STABLE
    PARALLEL SAFE
    AS $$
      SELECT string_agg(
               term::text,
               CASE WHEN match_all THEN ' & ' ELSE ' | ' END
             )::tsquery
      FROM unnest(knowledge_zh_query_terms(query)) AS term
    $$
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS knowledge_zh_tsquery(text, boolean)`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS knowledge_zh_query_terms(text)`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_knowledge_chunks_search_tsv_zh`.execute(
    db,
  );
  await sql`
    DROP TRIGGER IF EXISTS knowledge_chunks_search_tsv_zh_refresh
      ON knowledge_chunks
  `.execute(db);
  await sql`DROP FUNCTION IF EXISTS knowledge_chunks_search_tsv_zh_refresh()`.execute(
    db,
  );
  await sql`ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS search_tsv_zh`.execute(
    db,
  );
  // pg_jieba is left installed: other objects may depend on it and dropping an
  // extension is not needed to restore the previous schema.
}
