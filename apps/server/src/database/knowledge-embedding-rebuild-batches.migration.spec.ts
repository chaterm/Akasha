import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../common/helpers';

const migrationPath = resolve(
  __dirname,
  'migrations/20261014T170000-knowledge-embedding-rebuild-batches.ts',
);

describe('knowledge embedding rebuild batches migration', () => {
  it('creates a bounded aggregate usage table scoped per Space', async () => {
    const source = await readFile(migrationPath, 'utf8');

    expect(source).toContain(
      "createTable('knowledge_embedding_rebuild_batches')",
    );
    expect(source).toContain("addColumn('chunk_count', 'integer'");
    expect(source).toContain("addColumn('total_tokens', 'integer'");
    expect(source).toContain("addColumn('duration_ms', 'integer'");
    expect(source).toContain("references('workspaces.id').onDelete('cascade')");
    expect(source).toContain("references('spaces.id').onDelete('cascade')");
    expect(source).toContain(
      'knowledge_embedding_rebuild_batches_counts_check',
    );
    expect(source).toContain('idx_knowledge_embedding_rebuild_batches_scope');
    expect(source).toContain(
      "dropTable('knowledge_embedding_rebuild_batches')",
    );
  });
});

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres(
  'knowledge embedding rebuild batches PostgreSQL round trip',
  () => {
    const schema = `akasha_rebuild_batch_${process.pid}_${Date.now()}`;
    let client: ReturnType<typeof postgres>;
    let db: Kysely<unknown>;

    beforeAll(async () => {
      client = postgres(normalizePostgresUrl(integrationDatabaseUrl!), {
        max: 1,
        onnotice: () => {},
      });
      db = new Kysely({ dialect: new PostgresJSDialect({ postgres: client }) });
      await sql.raw(`create schema "${schema}"`).execute(db);
      await sql.raw(`set search_path to "${schema}"`).execute(db);
      await sql`
        create or replace function gen_uuid_v7() returns uuid
          language sql volatile as $$ select gen_random_uuid() $$;
        create table workspaces (id uuid primary key);
        create table spaces (id uuid primary key);
        insert into workspaces (id)
          values ('11111111-1111-4111-8111-111111111111');
        insert into spaces (id)
          values ('22222222-2222-4222-8222-222222222222');
      `.execute(db);
    });

    afterAll(async () => {
      if (!db) return;
      await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
      await db.destroy();
    });

    it('accepts aggregate rows, rejects negatives, and supports Up -> Down', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const migration = require(migrationPath) as {
        up(database: Kysely<unknown>): Promise<void>;
        down(database: Kysely<unknown>): Promise<void>;
      };

      await migration.up(db);

      await sql`
        insert into knowledge_embedding_rebuild_batches
          (workspace_id, space_id, chunk_count, failed_count,
           total_tokens, duration_ms, embedding_profile, embedding_model)
        values
          ('11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           50, 1, 1200, 70000, repeat('a', 64), 'text-embedding-3-small'),
          ('11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           20, 0, null, 25000, repeat('a', 64), 'text-embedding-3-small')
      `.execute(db);

      const summary = await sql<{
        batches: number;
        chunks: number;
        tokens: number | null;
        duration: number;
      }>`
        select count(*)::integer as batches,
               sum(chunk_count)::integer as chunks,
               sum(total_tokens)::integer as tokens,
               sum(duration_ms)::integer as duration
        from knowledge_embedding_rebuild_batches
      `.execute(db);
      expect(summary.rows[0]).toEqual({
        batches: 2,
        chunks: 70,
        tokens: 1200,
        duration: 95000,
      });

      await expect(
        sql`
          insert into knowledge_embedding_rebuild_batches
            (workspace_id, space_id, chunk_count, duration_ms)
          values ('11111111-1111-4111-8111-111111111111',
                  '22222222-2222-4222-8222-222222222222', -1, 10)
        `.execute(db),
      ).rejects.toThrow();

      const indexes = await sql<{ indexname: string }>`
        select indexname from pg_indexes
        where schemaname = current_schema()
          and indexname = 'idx_knowledge_embedding_rebuild_batches_scope'
      `.execute(db);
      expect(indexes.rows).toHaveLength(1);

      await migration.down(db);
      const remaining = await sql<{ count: number }>`
        select count(*)::integer as count
        from information_schema.tables
        where table_schema = current_schema()
          and table_name = 'knowledge_embedding_rebuild_batches'
      `.execute(db);
      expect(remaining.rows[0]?.count).toBe(0);
    });
  },
);
