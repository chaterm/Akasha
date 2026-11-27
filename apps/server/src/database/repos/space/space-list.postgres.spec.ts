import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KyselyDB } from '../../types/kysely.types';
import { SpaceMemberRepo } from './space-member.repo';
import { SpaceRepo } from './space.repo';
import { SpaceListOptions } from './types';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('space list ordering', () => {
  const schema = `akasha_space_list_${process.pid}_${Date.now()}`;
  let db: KyselyDB;
  let spaceRepo: SpaceRepo;
  let spaceMemberRepo: SpaceMemberRepo;

  beforeAll(async () => {
    db = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(normalizePostgresUrl(databaseUrl), { max: 1 }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    await sql`create schema ${sql.id(schema)}`.execute(db);
    await sql`set search_path to ${sql.id(schema)}`.execute(db);
    await sql`
      create table spaces (
        id text primary key,
        name text not null,
        workspace_id text not null,
        personal_owner_id text,
        creator_id text not null,
        is_default_personal boolean not null,
        deleted_at timestamptz
      )
    `.execute(db);
    await sql`create table space_members (space_id text, user_id text, group_id text)`.execute(
      db,
    );
    await sql`create table groups (id text)`.execute(db);
    await sql`create table group_users (group_id text, user_id text)`.execute(
      db,
    );
    await sql`
      insert into spaces values
        ('default', 'Zulu', 'workspace', 'user', 'user', true, null),
        ('early', 'Alpha', 'workspace', 'user', 'user', false, null),
        ('late', 'Beta', 'workspace', 'user', 'user', false, null),
        ('other', 'Aardvark', 'workspace', 'other-user', 'other-user', true, null),
        ('public', 'A Public Space', 'workspace', null, 'user', false, null)
    `.execute(db);
    await sql`insert into space_members select id, personal_owner_id, null from spaces`.execute(
      db,
    );
    await sql`insert into space_members values ('public', 'user', null)`.execute(
      db,
    );
    spaceRepo = new SpaceRepo(db, undefined);
    spaceMemberRepo = new SpaceMemberRepo(db, undefined, spaceRepo, undefined);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db);
    } finally {
      await db.destroy();
    }
  });

  it.each(['workspace', 'member'] as const)(
    'puts the default personal space first before paginating the %s list',
    async (scope) => {
      const options: SpaceListOptions = {
        type: 'created-personal',
        ownerId: 'user',
        limit: 1,
        query: '',
        adminView: scope === 'workspace',
      };
      const list = (pagination: SpaceListOptions) =>
        scope === 'workspace'
          ? spaceRepo.getSpacesInWorkspace('workspace', pagination)
          : spaceMemberRepo.getUserSpaces('user', pagination);

      const first = await list(options);
      expect(first.items.map((space) => space.id)).toEqual(['default']);
      expect(first.meta.total).toBe(3);
      expect(first.meta.nextCursor).toBeTruthy();

      const second = await list({ ...options, cursor: first.meta.nextCursor });
      expect(second.items.map((space) => space.id)).toEqual(['early']);
      expect(second.meta.nextCursor).toBeTruthy();

      const third = await list({ ...options, cursor: second.meta.nextCursor });
      expect(third.items.map((space) => space.id)).toEqual(['late']);
      expect(third.meta.hasNextPage).toBe(false);

      const previous = await list({
        ...options,
        beforeCursor: second.meta.prevCursor,
      });
      expect(previous.items.map((space) => space.id)).toEqual(['default']);
    },
  );

  it.each(['workspace', 'member'] as const)(
    'orders the %s list by space type across page boundaries',
    async (scope) => {
      const options: SpaceListOptions = {
        sortByType: true,
        limit: 2,
        query: '',
        adminView: scope === 'workspace',
      };
      const list = (pagination: SpaceListOptions) =>
        scope === 'workspace'
          ? spaceRepo.getSpacesInWorkspace('workspace', pagination)
          : spaceMemberRepo.getUserSpaces('user', pagination);
      const firstIds =
        scope === 'workspace' ? ['public', 'other'] : ['public', 'default'];
      const secondIds =
        scope === 'workspace' ? ['default', 'early'] : ['early', 'late'];

      const first = await list(options);
      expect(first.items.map(({ id }) => id)).toEqual(firstIds);
      expect(first.meta.nextCursor).toBeTruthy();

      const second = await list({ ...options, cursor: first.meta.nextCursor });
      expect(second.items.map(({ id }) => id)).toEqual(secondIds);
      const previous = await list({
        ...options,
        beforeCursor: second.meta.prevCursor,
      });
      expect(previous.items.map(({ id }) => id)).toEqual(firstIds);

      if (scope === 'workspace') {
        expect(second.meta.nextCursor).toBeTruthy();
        const last = await list({ ...options, cursor: second.meta.nextCursor });
        expect(last.items.map(({ id }) => id)).toEqual(['late']);
      } else {
        expect(second.meta.nextCursor).toBeNull();
      }
    },
  );
});
