import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../common/helpers';
import {
  down,
  up,
} from './migrations/20260805T100000-delayed-knowledge-page-compilation';

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('delayed Knowledge page compilation migration', () => {
  const schema = `akasha_delayed_page_${randomUUID().replaceAll('-', '')}`;
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
    await sql.raw(`set search_path to "${schema}", public`).execute(db);
    await sql`
      CREATE FUNCTION gen_uuid_v7() RETURNS uuid
      LANGUAGE sql AS 'SELECT gen_random_uuid()'
    `.execute(db);
    await sql`CREATE TABLE workspaces (id uuid PRIMARY KEY)`.execute(db);
    await sql`
      CREATE TABLE spaces (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces(id)
      )
    `.execute(db);
    await sql`
      CREATE TABLE pages (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces(id),
        space_id uuid NOT NULL REFERENCES spaces(id)
      )
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('creates a constrained page schedule with cascading cleanup', async () => {
    await up(db);
    const workspaceId = randomUUID();
    const spaceId = randomUUID();
    const pageId = randomUUID();
    await sql`INSERT INTO workspaces (id) VALUES (${workspaceId})`.execute(db);
    await sql`
      INSERT INTO spaces (id, workspace_id) VALUES (${spaceId}, ${workspaceId})
    `.execute(db);
    await sql`
      INSERT INTO pages (id, workspace_id, space_id)
      VALUES (${pageId}, ${workspaceId}, ${spaceId})
    `.execute(db);
    await sql`
      INSERT INTO knowledge_page_compile_schedules (
        workspace_id, space_id, source_page_id, trigger,
        first_changed_at, last_changed_at, eligible_at
      ) VALUES (
        ${workspaceId}, ${spaceId}, ${pageId}, 'page_updated',
        now(), now(), now() + interval '1 hour'
      )
    `.execute(db);

    const beforeDelete = await sql<{ count: number }>`
      SELECT count(*)::integer AS count
      FROM knowledge_page_compile_schedules
    `.execute(db);
    expect(beforeDelete.rows).toEqual([{ count: 1 }]);

    await expect(
      sql`
        UPDATE knowledge_page_compile_schedules
        SET trigger = 'manual_compile'
        WHERE source_page_id = ${pageId}
      `.execute(db),
    ).rejects.toBeDefined();

    await sql`DELETE FROM pages WHERE id = ${pageId}`.execute(db);
    const afterDelete = await sql<{ count: number }>`
      SELECT count(*)::integer AS count
      FROM knowledge_page_compile_schedules
    `.execute(db);
    expect(afterDelete.rows).toEqual([{ count: 0 }]);

    await down(db);
    const table = await sql<{ relation: string | null }>`
      SELECT to_regclass('knowledge_page_compile_schedules')::text AS relation
    `.execute(db);
    expect(table.rows).toEqual([{ relation: null }]);
  });
});
