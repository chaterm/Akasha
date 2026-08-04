import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { PagePermissionRepo } from './page-permission.repo';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;

const ids = {
  space: '00000000-0000-4000-8000-000000000001',
  userA: '00000000-0000-4000-8000-000000000101',
  userB: '00000000-0000-4000-8000-000000000102',
  userC: '00000000-0000-4000-8000-000000000103',
  group: '00000000-0000-4000-8000-000000000201',
  root: '00000000-0000-4000-8000-000000000301',
  parent: '00000000-0000-4000-8000-000000000302',
  leaf: '00000000-0000-4000-8000-000000000303',
  standalone: '00000000-0000-4000-8000-000000000304',
  rootAccess: '00000000-0000-4000-8000-000000000401',
  parentAccess: '00000000-0000-4000-8000-000000000402',
  standaloneAccess: '00000000-0000-4000-8000-000000000403',
};

describePostgres('PagePermissionRepo PostgreSQL recursive access', () => {
  const schema = `akasha_page_permission_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: PagePermissionRepo;

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
    await createFixture(db);
    repo = new PagePermissionRepo(db as never, undefined, undefined);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`
      truncate table page_permissions, group_users, page_access, pages
    `.execute(db);
  });

  it('uses the unrestricted-space fast path without limiting page count or order', async () => {
    await insertPage(db, ids.root);
    await insertPage(db, ids.standalone);

    await expect(
      repo.filterAccessiblePageIds({
        pageIds: [ids.standalone, ids.root],
        userId: ids.userA,
        spaceId: ids.space,
      }),
    ).resolves.toEqual([ids.standalone, ids.root]);
  });

  it('enforces a restriction placed directly on the requested page', async () => {
    await insertPage(db, ids.standalone);
    await restrictPage(db, ids.standaloneAccess, ids.standalone);
    await grantUser(db, ids.standaloneAccess, ids.userA);

    await expect(filter(repo, ids.standalone, ids.userA)).resolves.toEqual([
      ids.standalone,
    ]);
    await expect(filter(repo, ids.standalone, ids.userB)).resolves.toEqual([]);
  });

  it('inherits a restricted parent and accepts a group grant', async () => {
    await insertPage(db, ids.parent);
    await insertPage(db, ids.leaf, ids.parent);
    await restrictPage(db, ids.parentAccess, ids.parent);
    await grantGroup(db, ids.parentAccess, ids.group);
    await addGroupUser(db, ids.group, ids.userB);

    await expect(filter(repo, ids.leaf, ids.userB)).resolves.toEqual([
      ids.leaf,
    ]);
    await expect(filter(repo, ids.leaf, ids.userC)).resolves.toEqual([]);
  });

  it('requires permission on every restricted ancestor', async () => {
    await insertPage(db, ids.root);
    await insertPage(db, ids.parent, ids.root);
    await insertPage(db, ids.leaf, ids.parent);
    await restrictPage(db, ids.rootAccess, ids.root);
    await restrictPage(db, ids.parentAccess, ids.parent);
    await grantUser(db, ids.rootAccess, ids.userA);

    await expect(filter(repo, ids.leaf, ids.userA)).resolves.toEqual([]);

    await grantUser(db, ids.parentAccess, ids.userA);
    await expect(filter(repo, ids.leaf, ids.userA)).resolves.toEqual([
      ids.leaf,
    ]);
  });
});

async function createFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table pages (
      id uuid primary key,
      parent_page_id uuid null references pages(id) on delete cascade,
      space_id uuid not null
    )
  `.execute(db);
  await sql`
    create table page_access (
      id uuid primary key,
      page_id uuid not null unique references pages(id) on delete cascade,
      space_id uuid not null
    )
  `.execute(db);
  await sql`
    create table page_permissions (
      id bigint generated always as identity primary key,
      page_access_id uuid not null references page_access(id) on delete cascade,
      user_id uuid null,
      group_id uuid null,
      role varchar not null
    )
  `.execute(db);
  await sql`
    create table group_users (
      id bigint generated always as identity primary key,
      group_id uuid not null,
      user_id uuid not null
    )
  `.execute(db);
}

async function insertPage(
  db: Kysely<unknown>,
  pageId: string,
  parentPageId?: string,
): Promise<void> {
  await sql`
    insert into pages (id, parent_page_id, space_id)
    values (${pageId}::uuid, ${parentPageId ?? null}::uuid, ${ids.space}::uuid)
  `.execute(db);
}

async function restrictPage(
  db: Kysely<unknown>,
  pageAccessId: string,
  pageId: string,
): Promise<void> {
  await sql`
    insert into page_access (id, page_id, space_id)
    values (${pageAccessId}::uuid, ${pageId}::uuid, ${ids.space}::uuid)
  `.execute(db);
}

async function grantUser(
  db: Kysely<unknown>,
  pageAccessId: string,
  userId: string,
): Promise<void> {
  await sql`
    insert into page_permissions (page_access_id, user_id, role)
    values (${pageAccessId}::uuid, ${userId}::uuid, 'reader')
  `.execute(db);
}

async function grantGroup(
  db: Kysely<unknown>,
  pageAccessId: string,
  groupId: string,
): Promise<void> {
  await sql`
    insert into page_permissions (page_access_id, group_id, role)
    values (${pageAccessId}::uuid, ${groupId}::uuid, 'reader')
  `.execute(db);
}

async function addGroupUser(
  db: Kysely<unknown>,
  groupId: string,
  userId: string,
): Promise<void> {
  await sql`
    insert into group_users (group_id, user_id)
    values (${groupId}::uuid, ${userId}::uuid)
  `.execute(db);
}

function filter(
  repo: PagePermissionRepo,
  pageId: string,
  userId: string,
): Promise<string[]> {
  return repo.filterAccessiblePageIds({
    pageIds: [pageId],
    userId,
    spaceId: ids.space,
  });
}
