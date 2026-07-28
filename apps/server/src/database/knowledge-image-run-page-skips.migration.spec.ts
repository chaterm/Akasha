import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../common/helpers';

const migrationPath = path.join(
  __dirname,
  'migrations/20260728T120000-knowledge-image-run-page-skips.ts',
);

describe('knowledge image RunPage skipped counter migration', () => {
  it('adds a nonnegative skipped counter to the image count invariant', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    expect(migration).toContain("addColumn('skipped_image_count'");
    expect(migration).toContain('skipped_image_count >= 0');
    expect(migration).toContain(
      'succeeded_image_count + failed_image_count + skipped_image_count',
    );
  });
});

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres(
  'knowledge image skipped counter PostgreSQL round trip',
  () => {
    const schema = `akasha_image_skip_migration_${process.pid}_${Date.now()}`;
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
      create table knowledge_space_compile_run_pages (
        id varchar primary key,
        expected_image_count integer not null default 0,
        succeeded_image_count integer not null default 0,
        failed_image_count integer not null default 0,
        constraint chk_knowledge_space_compile_run_pages_image_counts
          check (
            expected_image_count >= 0 and
            succeeded_image_count >= 0 and
            failed_image_count >= 0 and
            succeeded_image_count + failed_image_count <= expected_image_count
          )
      );
      insert into knowledge_space_compile_run_pages
        (id, expected_image_count, succeeded_image_count)
      values ('historical', 1, 1)
    `.execute(db);
    });

    afterAll(async () => {
      if (!db) return;
      await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
      await db.destroy();
    });

    it('preserves rows and enforces succeeded + failed + skipped <= expected', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const migration = require(migrationPath) as {
        up(database: Kysely<unknown>): Promise<void>;
        down(database: Kysely<unknown>): Promise<void>;
      };
      await migration.up(db);
      const historical = await sql<{
        id: string;
        skipped: number;
      }>`
      select id, skipped_image_count as skipped
      from knowledge_space_compile_run_pages
    `.execute(db);
      expect(historical.rows).toEqual([{ id: 'historical', skipped: 0 }]);
      await expect(
        sql`
        update knowledge_space_compile_run_pages
        set skipped_image_count = 1
        where id = 'historical'
      `.execute(db),
      ).rejects.toMatchObject({ code: '23514' });
      await migration.down(db);
    });
  },
);
