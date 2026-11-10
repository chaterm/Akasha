import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeRunRetentionService } from './knowledge-run-retention.service';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('KnowledgeRunRetentionService PostgreSQL', () => {
  const schema = `akasha_run_retention_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let service: KnowledgeRunRetentionService;

  beforeAll(async () => {
    const bootstrap = postgres(normalizePostgresUrl(databaseUrl!), {
      max: 1,
      onnotice: () => {},
    });
    await bootstrap.unsafe(`create schema "${schema}"`);
    await bootstrap.end();
    client = postgres(normalizePostgresUrl(databaseUrl!), {
      max: 2,
      onnotice: () => {},
      connection: { search_path: schema },
    });
    db = new Kysely({
      dialect: new PostgresJSDialect({ postgres: client }),
      plugins: [new CamelCasePlugin()],
    });
    await createTables(db);
    service = new KnowledgeRunRetentionService(db as never);
  });

  beforeEach(async () => {
    await seedFixture(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('purges expired eligible runs and protects current published or active history', async () => {
    const result = await service.purgeExpiredRunHistoryBatch();

    expect(result).toEqual(
      expect.objectContaining({
        deletedImages: 2,
        deletedPages: 2,
        deletedRuns: 2,
      }),
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const remaining = await sql<{ id: string }>`
      SELECT id FROM knowledge_space_compile_runs ORDER BY id
    `.execute(db);
    expect(remaining.rows.map((row) => row.id)).toEqual([
      'run-active-old-generation',
      'run-current-partial',
      'run-current-succeeded',
      'run-fresh-superseded',
    ]);
  });

  it('does not double-delete rows when two instances run concurrently', async () => {
    const other = new KnowledgeRunRetentionService(db as never);

    const results = await Promise.all([
      service.purgeExpiredRunHistoryBatch(),
      other.purgeExpiredRunHistoryBatch(),
    ]);

    expect(sum(results, 'deletedImages')).toBe(2);
    expect(sum(results, 'deletedPages')).toBe(2);
    expect(sum(results, 'deletedRuns')).toBe(2);
  });

  it('deletes at most one thousand RunImages per batch', async () => {
    await sql`
      TRUNCATE knowledge_space_compile_run_images,
        knowledge_space_compile_run_pages,
        knowledge_space_compile_runs,
        spaces CASCADE;
      INSERT INTO spaces VALUES ('space-bulk', 2);
      INSERT INTO knowledge_space_compile_runs VALUES (
        'run-bulk', 'space-bulk', 1, 'succeeded', now() - interval '31 days'
      );
      INSERT INTO knowledge_space_compile_run_pages VALUES ('page-bulk', 'run-bulk');
      INSERT INTO knowledge_space_compile_run_images (id, run_id, run_page_id)
        SELECT 'image-bulk-' || value, 'run-bulk', 'page-bulk'
        FROM generate_series(1, 1001) AS value;
    `.execute(db);

    await expect(service.purgeExpiredRunHistoryBatch()).resolves.toEqual(
      expect.objectContaining({
        deletedImages: 1_000,
        deletedPages: 0,
        deletedRuns: 0,
      }),
    );
    await expect(service.purgeExpiredRunHistoryBatch()).resolves.toEqual(
      expect.objectContaining({
        deletedImages: 1,
        deletedPages: 1,
        deletedRuns: 1,
      }),
    );
  });
});

async function createTables(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE spaces (
      id varchar PRIMARY KEY,
      knowledge_generation integer NOT NULL
    );
    CREATE TABLE knowledge_space_compile_runs (
      id varchar PRIMARY KEY,
      space_id varchar NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      knowledge_generation integer NOT NULL,
      status varchar NOT NULL,
      finished_at timestamptz
    );
    CREATE TABLE knowledge_space_compile_run_pages (
      id varchar PRIMARY KEY,
      run_id varchar NOT NULL REFERENCES knowledge_space_compile_runs(id) ON DELETE CASCADE
    );
    CREATE TABLE knowledge_space_compile_run_images (
      id varchar PRIMARY KEY,
      run_id varchar NOT NULL REFERENCES knowledge_space_compile_runs(id) ON DELETE CASCADE,
      run_page_id varchar NOT NULL REFERENCES knowledge_space_compile_run_pages(id) ON DELETE CASCADE
    );

  `.execute(db);
}

async function seedFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    TRUNCATE knowledge_space_compile_run_images,
      knowledge_space_compile_run_pages,
      knowledge_space_compile_runs,
      spaces CASCADE;
    INSERT INTO spaces VALUES ('space-1', 3);
    INSERT INTO knowledge_space_compile_runs VALUES
      ('run-old-generation', 'space-1', 2, 'succeeded', now() - interval '31 days'),
      ('run-current-failed', 'space-1', 3, 'failed', now() - interval '31 days'),
      ('run-current-succeeded', 'space-1', 3, 'succeeded', now() - interval '31 days'),
      ('run-current-partial', 'space-1', 3, 'partial', now() - interval '31 days'),
      ('run-active-old-generation', 'space-1', 2, 'compiling', null),
      ('run-fresh-superseded', 'space-1', 2, 'superseded', now() - interval '29 days');
    INSERT INTO knowledge_space_compile_run_pages (id, run_id)
      SELECT 'page-' || id, id FROM knowledge_space_compile_runs;
    INSERT INTO knowledge_space_compile_run_images (id, run_id, run_page_id)
      SELECT 'image-' || id, id, 'page-' || id FROM knowledge_space_compile_runs;
  `.execute(db);
}

function sum(
  results: Array<{
    deletedImages: number;
    deletedPages: number;
    deletedRuns: number;
  }>,
  key: 'deletedImages' | 'deletedPages' | 'deletedRuns',
): number {
  return results.reduce((total, result) => total + result[key], 0);
}
