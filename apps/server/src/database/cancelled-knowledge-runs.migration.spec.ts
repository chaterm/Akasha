import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../common/helpers';
import {
  down,
  up,
} from './migrations/20260803T120000-cancelled-knowledge-runs';

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('cancelled Knowledge Run migration', () => {
  const schema = `akasha_cancel_status_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    client = postgres(normalizePostgresUrl(integrationDatabaseUrl!), {
      max: 1,
      onnotice: () => {},
    });
    db = new Kysely({
      dialect: new PostgresJSDialect({ postgres: client }),
      plugins: [new CamelCasePlugin()],
    });
    await sql.raw(`create schema "${schema}"`).execute(db);
    await sql.raw(`set search_path to "${schema}"`).execute(db);
    await sql`
      CREATE TABLE knowledge_space_compile_runs (
        id varchar PRIMARY KEY,
        status varchar NOT NULL,
        error_code varchar,
        error_message varchar,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_knowledge_space_compile_runs_status CHECK (status IN (
          'queued', 'compiling', 'aggregate_pending', 'aggregating',
          'succeeded', 'partial', 'failed', 'superseded'
        ))
      )
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('adds the explicit terminal status and restores legacy rows on down', async () => {
    await up(db);
    await sql`
      INSERT INTO knowledge_space_compile_runs (id, status)
      VALUES ('run-cancelled', 'cancelled')
    `.execute(db);
    await down(db);

    const row = await sql<{
      status: string;
      errorCode: string | null;
    }>`
      SELECT status, error_code AS "errorCode"
      FROM knowledge_space_compile_runs
      WHERE id = 'run-cancelled'
    `.execute(db);
    expect(row.rows).toEqual([
      { status: 'superseded', errorCode: 'run_superseded' },
    ]);
    await expect(
      sql`
        INSERT INTO knowledge_space_compile_runs (id, status)
        VALUES ('run-invalid', 'cancelled')
      `.execute(db),
    ).rejects.toBeDefined();
  });
});
