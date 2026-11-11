import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { PageRepo } from './page.repo';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;

const ids = {
  root: '00000000-0000-4000-8000-000000000301',
  child: '00000000-0000-4000-8000-000000000302',
  grandchild: '00000000-0000-4000-8000-000000000303',
  other: '00000000-0000-4000-8000-000000000304',
  loopA: '00000000-0000-4000-8000-000000000305',
  loopB: '00000000-0000-4000-8000-000000000306',
};

describePostgres('PageRepo PostgreSQL isSelfOrAncestor', () => {
  const schema = `akasha_page_repo_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: PageRepo;

  beforeAll(async () => {
    client = postgres(normalizePostgresUrl(databaseUrl!), {
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
      create table pages (
        id uuid primary key,
        parent_page_id uuid null references pages(id) on delete cascade
      )
    `.execute(db);
    await insertPage(db, ids.root);
    await insertPage(db, ids.child, ids.root);
    await insertPage(db, ids.grandchild, ids.child);
    await insertPage(db, ids.other);
    await insertPage(db, ids.loopA);
    await insertPage(db, ids.loopB, ids.loopA);
    await sql`
      update pages set parent_page_id = ${ids.loopB}::uuid
      where id = ${ids.loopA}::uuid
    `.execute(db);
    repo = new PageRepo(db as never, undefined, undefined);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('matches the page itself', async () => {
    await expect(repo.isSelfOrAncestor(ids.root, ids.root)).resolves.toBe(true);
  });

  it('matches every ancestor of a descendant', async () => {
    await expect(
      repo.isSelfOrAncestor(ids.grandchild, ids.child),
    ).resolves.toBe(true);
    await expect(repo.isSelfOrAncestor(ids.grandchild, ids.root)).resolves.toBe(
      true,
    );
  });

  it('does not match descendants or unrelated pages', async () => {
    await expect(repo.isSelfOrAncestor(ids.root, ids.child)).resolves.toBe(
      false,
    );
    await expect(repo.isSelfOrAncestor(ids.other, ids.root)).resolves.toBe(
      false,
    );
  });

  it('terminates on an existing cycle', async () => {
    await expect(repo.isSelfOrAncestor(ids.loopA, ids.root)).resolves.toBe(
      false,
    );
    await expect(repo.isSelfOrAncestor(ids.loopA, ids.loopB)).resolves.toBe(
      true,
    );
  });
});

async function insertPage(
  db: Kysely<unknown>,
  pageId: string,
  parentPageId?: string,
): Promise<void> {
  await sql`
    insert into pages (id, parent_page_id)
    values (${pageId}::uuid, ${parentPageId ?? null}::uuid)
  `.execute(db);
}
