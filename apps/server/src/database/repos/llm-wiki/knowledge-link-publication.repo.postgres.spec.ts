import { Logger } from '@nestjs/common';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KyselyDB } from '../../types/kysely.types';
import {
  KnowledgeCapsuleRepo,
  UpsertCompiledArtifactInput,
} from './knowledge-capsule.repo';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;
const WS = '00000000-0000-4000-8000-000000000001';
const SPACE = '00000000-0000-4000-8000-000000000002';
const OWNER = '00000000-0000-4000-8000-000000000010';
const TARGET = '00000000-0000-4000-8000-000000000020';
const LINK = '00000000-0000-4000-8000-000000000030';

describePostgres('KnowledgeCapsuleRepo link publication foreign keys', () => {
  const schema = `akasha_link_publication_${process.pid}_${Date.now()}`;
  let db: KyselyDB;
  let repo: KnowledgeCapsuleRepo;

  beforeAll(async () => {
    const client = postgres(normalizePostgresUrl(databaseUrl!), {
      max: 2,
      connection: { search_path: schema },
      onnotice: () => {},
    });
    db = new Kysely({
      dialect: new PostgresJSDialect({ postgres: client }),
      plugins: [new CamelCasePlugin()],
    });
    await sql.raw(`create schema "${schema}"`).execute(db);
    await createTables(db);
    repo = new KnowledgeCapsuleRepo(db);
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await sql.raw('truncate table knowledge_pages cascade').execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('handles a replayed link to a deleted page and resolves it when the canonical target returns', async () => {
    // The contribution JSON keeps this ID even after the target row is deleted.
    await db
      .insertInto('knowledgePages')
      .values(page(TARGET, 'old-concept'))
      .execute();
    const historicalLink = link(OWNER, TARGET);
    await db.deleteFrom('knowledgePages').where('id', '=', TARGET).execute();

    // Pin down the original failure against the real FK, before the repair.
    await db
      .insertInto('knowledgePages')
      .values(page(OWNER, 'owner'))
      .execute();
    await expect(
      db.insertInto('knowledgeLinks').values(historicalLink).execute(),
    ).rejects.toMatchObject({
      code: '23503',
      constraint_name: 'knowledge_links_to_knowledge_page_id_fkey',
    });

    await db.transaction().execute((trx) =>
      repo.upsertCompiledArtifacts(
        [
          {
            page: page(OWNER, 'owner'),
            links: [historicalLink],
            linkSources: [
              {
                workspaceId: WS,
                linkId: LINK,
                sourcePageId: OWNER,
                sourceVersion: 'v1',
                contentHash: 'source-hash',
                provenanceKind: 'synthesis_lineage',
              },
            ],
          },
        ],
        trx,
      ),
    );

    expect(
      await db
        .selectFrom('knowledgeLinks')
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      id: LINK,
      toKnowledgePageId: null,
      isDangling: true,
      targetArtifactKind: 'concept',
      targetCanonicalKey: 'old-concept',
    });
    expect(
      await db.selectFrom('knowledgeLinkSources').selectAll().execute(),
    ).toHaveLength(1);
    expect(historicalLink.toKnowledgePageId).toBe(TARGET);

    await db
      .insertInto('knowledgePages')
      .values(page(TARGET, 'old-concept'))
      .execute();
    await expect(
      repo.resolveCanonicalReferences({ workspaceId: WS, spaceId: SPACE }),
    ).resolves.toEqual({ resolvedLinkCount: 1 });
    expect(
      await db
        .selectFrom('knowledgeLinks')
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      toKnowledgePageId: TARGET,
      isDangling: false,
    });
  });

  it('preserves links to existing targets and between newly published pages', async () => {
    const first = { page: page(OWNER, 'owner'), links: [link(OWNER, TARGET)] };
    const second = {
      page: page(TARGET, 'old-concept'),
      links: [
        { ...link(TARGET, OWNER), id: '00000000-0000-4000-8000-000000000031' },
      ],
    };
    await db
      .transaction()
      .execute((trx) => repo.upsertCompiledArtifacts([first, second], trx));
    // Publish again with TARGET now coming from the existing catalog.
    await db
      .transaction()
      .execute((trx) => repo.upsertCompiledArtifacts([first], trx));
    expect(
      await db
        .selectFrom('knowledgeLinks')
        .select(['toKnowledgePageId', 'isDangling'])
        .orderBy('id')
        .execute(),
    ).toEqual([
      { toKnowledgePageId: TARGET, isDangling: false },
      { toKnowledgePageId: OWNER, isDangling: false },
    ]);
  });

  it('still rolls back publication on unrelated database errors', async () => {
    const invalid = { ...link(OWNER, null), isDangling: null };
    await expect(
      db
        .transaction()
        .execute((trx) =>
          repo.upsertCompiledArtifacts(
            [{ page: page(OWNER, 'owner'), links: [invalid] }],
            trx,
          ),
        ),
    ).rejects.toMatchObject({ code: '23502' });
    expect(
      await db.selectFrom('knowledgePages').select('id').execute(),
    ).toEqual([]);
  });
});

function page(
  id: string,
  canonicalKey: string,
): UpsertCompiledArtifactInput['page'] {
  return {
    id,
    workspaceId: WS,
    spaceId: SPACE,
    compileScope: 'page',
    title: canonicalKey,
    slug: id,
    body: 'body',
    compiledAt: new Date(),
    compilerVersion: 'test',
    pageType: 'concept',
    canonicalKey,
  };
}

function link(from: string, to: string | null) {
  return {
    id: LINK,
    workspaceId: WS,
    spaceId: SPACE,
    fromKnowledgePageId: from,
    toKnowledgePageId: to,
    targetSpaceId: SPACE,
    targetArtifactKind: 'concept',
    targetCanonicalKey: 'old-concept',
    linkText: 'Concept',
    linkType: 'mentions',
    isDangling: to === null,
  };
}

async function createTables(db: KyselyDB) {
  await sql
    .raw(
      `create table knowledge_pages (
    id uuid primary key, workspace_id uuid not null, space_id uuid not null,
    compile_scope text not null, title text not null, slug text not null,
    body text not null, compiled_at timestamptz not null, compiler_version text not null,
    generation_mode text default 'legacy', page_type text, canonical_key text,
    compiler_run_id text, compile_task_id text, stale_at timestamptz, updated_at timestamptz
  )`,
    )
    .execute(db);
  await sql
    .raw(
      `create table knowledge_links (
    id uuid primary key, workspace_id uuid not null, space_id uuid not null,
    from_knowledge_page_id uuid references knowledge_pages(id) on delete cascade,
    to_knowledge_page_id uuid,
    target_page_id uuid, target_space_id uuid, target_artifact_kind text,
    target_canonical_key text, link_text text, link_type text,
    is_dangling boolean not null, stale_at timestamptz, compiler_run_id text, compile_task_id text,
    constraint knowledge_links_to_knowledge_page_id_fkey
      foreign key (to_knowledge_page_id) references knowledge_pages(id) on delete set null
  )`,
    )
    .execute(db);
  await sql
    .raw(
      `create table knowledge_link_sources (
    workspace_id uuid, link_id uuid references knowledge_links(id) on delete cascade,
    source_page_id uuid, source_version text, content_hash text, provenance_kind text
  )`,
    )
    .execute(db);
  for (const table of [
    'knowledge_chunks',
    'knowledge_parent_sections',
    'knowledge_page_sources',
  ]) {
    await sql
      .raw(
        `create table ${table} (
      id uuid primary key, knowledge_page_id uuid references knowledge_pages(id) on delete cascade
    )`,
      )
      .execute(db);
  }
}
