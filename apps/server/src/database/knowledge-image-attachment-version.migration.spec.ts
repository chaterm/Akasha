import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../common/helpers';

const migrationPath = resolve(
  __dirname,
  'migrations/20260728T110000-knowledge-image-attachment-version.ts',
);

describe('knowledge image attachment version migration', () => {
  it('adds a nullable durable attachment version without rewriting the shipped migration', async () => {
    const source = await readFile(migrationPath, 'utf8');

    expect(source).toContain("addColumn('attachment_version', 'timestamptz')");
    expect(source).toContain("dropColumn('attachment_version')");
  });
});

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres(
  'knowledge image attachment version PostgreSQL round trip',
  () => {
    const schema = `akasha_image_migration_${process.pid}_${Date.now()}`;
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
      create table knowledge_image_extractions (
        id varchar primary key,
        status varchar not null
      );
      insert into knowledge_image_extractions values ('historical', 'ready')
    `.execute(db);
    });

    afterAll(async () => {
      if (!db) return;
      await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
      await db.destroy();
    });

    it('preserves historical rows as NULL and supports Up -> Down', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const migration = require(migrationPath) as {
        up(database: Kysely<unknown>): Promise<void>;
        down(database: Kysely<unknown>): Promise<void>;
      };

      await migration.up(db);
      const afterUp = await sql<{
        id: string;
        attachmentVersion: Date | null;
      }>`
      select id, attachment_version as "attachmentVersion"
      from knowledge_image_extractions
    `.execute(db);
      expect(afterUp.rows).toEqual([
        { id: 'historical', attachmentVersion: null },
      ]);
      logEvidence('after_up', afterUp.rows);

      await sql`
      update knowledge_image_extractions
      set attachment_version = '2026-07-28T01:00:00.000Z'
      where id = 'historical'
    `.execute(db);
      const persisted = await sql<{ attachmentVersion: Date }>`
      select attachment_version as "attachmentVersion"
      from knowledge_image_extractions
      where id = 'historical'
    `.execute(db);
      expect(persisted.rows[0]?.attachmentVersion.toISOString()).toBe(
        '2026-07-28T01:00:00.000Z',
      );
      logEvidence('persisted_exact_version', persisted.rows);

      await migration.down(db);
      const afterDown = await sql<{ count: number }>`
      select count(*)::integer as count
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'knowledge_image_extractions'
        and column_name = 'attachment_version'
    `.execute(db);
      expect(afterDown.rows).toEqual([{ count: 0 }]);
      logEvidence('after_down', afterDown.rows);
    });
  },
);

function logEvidence(stage: string, evidence: unknown): void {
  if (process.env.AKASHA_MIGRATION_TEST_EVIDENCE !== '1') return;
  console.info(
    'knowledge_image_attachment_migration_database_evidence',
    JSON.stringify({ stage, evidence }),
  );
}
