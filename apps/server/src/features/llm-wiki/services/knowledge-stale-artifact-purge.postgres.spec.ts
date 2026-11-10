import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeCapsuleRepo } from '../../../database/repos/llm-wiki/knowledge-capsule.repo';
import { KnowledgeRunRetentionService } from './knowledge-run-retention.service';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;

const WS = '00000000-0000-0000-0000-0000000000a1';
const SPACE = '00000000-0000-0000-0000-0000000000b1';
const BUSY_SPACE = '00000000-0000-0000-0000-0000000000b2';
// KnowledgePages
const ACTIVE = '00000000-0000-0000-0000-000000000c01';
const OLD_STALE = '00000000-0000-0000-0000-000000000c02';
const FRESH_STALE = '00000000-0000-0000-0000-000000000c03';
const OLD_STALE_SIBLING = '00000000-0000-0000-0000-000000000c04';
const BUSY_OLD_STALE = '00000000-0000-0000-0000-000000000c05';
// Links
const ACTIVE_LINK = '00000000-0000-0000-0000-000000000d01';
const STALE_LINK = '00000000-0000-0000-0000-000000000d02';
const STALE_INBOUND_LINK = '00000000-0000-0000-0000-000000000d03';

describePostgres('KnowledgeRunRetentionService stale artifact purge', () => {
  const schema = `akasha_stale_purge_${process.pid}_${Date.now()}`;
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

  it('deletes only pages stale beyond the grace period outside busy Spaces', async () => {
    const result = await service.purgeStaleArtifactsBatch();

    expect(result).toEqual(
      expect.objectContaining({
        deletedKnowledgePages: 2,
        danglingLinks: 1,
      }),
    );
    await expect(pageIds(db)).resolves.toEqual(
      [ACTIVE, FRESH_STALE, BUSY_OLD_STALE].sort(),
    );
  });

  it('cascades every child row of a deleted page', async () => {
    await service.purgeStaleArtifactsBatch();

    const orphans = await sql<{ table: string; count: number }>`
      SELECT 'chunks' AS table, count(*)::int AS count FROM knowledge_chunks
        WHERE knowledge_page_id IN (${OLD_STALE}, ${OLD_STALE_SIBLING})
      UNION ALL
      SELECT 'chunk_sources', count(*)::int FROM knowledge_chunk_sources
        WHERE chunk_id NOT IN (SELECT id FROM knowledge_chunks)
      UNION ALL
      SELECT 'sections', count(*)::int FROM knowledge_parent_sections
        WHERE knowledge_page_id IN (${OLD_STALE}, ${OLD_STALE_SIBLING})
      UNION ALL
      SELECT 'page_sources', count(*)::int FROM knowledge_page_sources
        WHERE knowledge_page_id IN (${OLD_STALE}, ${OLD_STALE_SIBLING})
    `.execute(db);
    expect(orphans.rows.every((row) => row.count === 0)).toBe(true);
    // Stale outbound link of the deleted sibling went with its owner.
    await expect(linkById(db, STALE_LINK)).resolves.toBeUndefined();
  });

  it('turns active inbound references into revivable dangling references', async () => {
    await service.purgeStaleArtifactsBatch();

    await expect(linkById(db, ACTIVE_LINK)).resolves.toEqual({
      isDangling: true,
      toKnowledgePageId: null,
      targetArtifactKind: 'concept',
      targetCanonicalKey: 'kafka',
    });
    // A stale inbound link (owned by a kept stale page) is not rewritten: it is
    // not counted, stays non-dangling and keeps its stale marker. Only the FK
    // ON DELETE SET NULL touches its target column.
    const staleInbound = await sql<{
      isDangling: boolean;
      toKnowledgePageId: string | null;
      isStale: boolean;
    }>`
      SELECT is_dangling, to_knowledge_page_id, stale_at IS NOT NULL AS is_stale
      FROM knowledge_links WHERE id = ${STALE_INBOUND_LINK}
    `.execute(db);
    expect(staleInbound.rows).toEqual([
      { isDangling: false, toKnowledgePageId: null, isStale: true },
    ]);
  });

  it('re-attaches the dangling references when the concept is republished', async () => {
    await service.purgeStaleArtifactsBatch();
    // A later compile regenerates the concept under the same stable id.
    await sql`
      INSERT INTO knowledge_pages (id, workspace_id, space_id, page_type, canonical_key, stale_at)
      VALUES (${OLD_STALE}, ${WS}, ${SPACE}, 'concept', 'kafka', NULL)
    `.execute(db);

    const resolved = await new KnowledgeCapsuleRepo(
      db as never,
    ).resolveCanonicalReferences({ workspaceId: WS, spaceId: SPACE });

    expect(resolved).toEqual({ resolvedLinkCount: 1 });
    await expect(linkById(db, ACTIVE_LINK)).resolves.toEqual(
      expect.objectContaining({
        isDangling: false,
        toKnowledgePageId: OLD_STALE,
      }),
    );
  });

  it('does not double-delete when two instances run concurrently', async () => {
    const other = new KnowledgeRunRetentionService(db as never);

    const results = await Promise.all([
      service.purgeStaleArtifactsBatch(),
      other.purgeStaleArtifactsBatch(),
    ]);

    expect(
      results.reduce(
        (total, result) => total + result.deletedKnowledgePages,
        0,
      ),
    ).toBe(2);
  });

  it('reports an empty batch once nothing is eligible', async () => {
    await service.purgeStaleArtifactsBatch();

    await expect(service.purgeStaleArtifactsBatch()).resolves.toEqual(
      expect.objectContaining({
        deletedKnowledgePages: 0,
        danglingLinks: 0,
        remainingLocked: false,
      }),
    );
  });

  it('distinguishes rows locked by another purger from an empty backlog', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockAcquired = new Promise<void>((resolve) => (locked = resolve));

    const holder = db.transaction().execute(async (trx) => {
      await sql`
        SELECT id FROM knowledge_pages
        WHERE stale_at IS NOT NULL
        FOR UPDATE
      `.execute(trx);
      locked();
      await held;
    });
    await lockAcquired;

    const result = await service.purgeStaleArtifactsBatch();
    release();
    await holder;

    expect(result).toEqual(
      expect.objectContaining({
        deletedKnowledgePages: 0,
        remainingLocked: true,
      }),
    );
  });
});

// Mirrors the baseline FK cascades that the purge relies on.
async function createTables(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE knowledge_space_compile_runs (
      id varchar PRIMARY KEY,
      workspace_id uuid NOT NULL,
      space_id uuid NOT NULL,
      status varchar NOT NULL
    );
    CREATE TABLE knowledge_pages (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      space_id uuid NOT NULL,
      page_type varchar,
      canonical_key varchar,
      stale_at timestamptz
    );
    CREATE TABLE knowledge_parent_sections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      knowledge_page_id uuid NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE
    );
    CREATE TABLE knowledge_chunks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      knowledge_page_id uuid NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
      parent_section_id uuid REFERENCES knowledge_parent_sections(id) ON DELETE CASCADE
    );
    CREATE TABLE knowledge_chunk_sources (
      chunk_id uuid NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
      source_page_id uuid NOT NULL
    );
    CREATE TABLE knowledge_page_sources (
      knowledge_page_id uuid NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
      source_page_id uuid NOT NULL
    );
    CREATE TABLE knowledge_links (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      space_id uuid NOT NULL,
      from_knowledge_page_id uuid NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
      to_knowledge_page_id uuid REFERENCES knowledge_pages(id) ON DELETE SET NULL,
      target_artifact_kind varchar,
      target_canonical_key varchar,
      is_dangling boolean NOT NULL DEFAULT false,
      stale_at timestamptz
    );
  `.execute(db);
}

// Parameterised statements use the extended protocol, which allows only one
// statement per query, so each insert is executed separately.
async function seedFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    TRUNCATE knowledge_pages, knowledge_space_compile_runs CASCADE
  `.execute(db);
  await sql`
    INSERT INTO knowledge_space_compile_runs VALUES
      ('run-busy', ${WS}, ${BUSY_SPACE}, 'compiling'),
      ('run-done', ${WS}, ${SPACE}, 'succeeded')
  `.execute(db);
  await sql`
    INSERT INTO knowledge_pages VALUES
      (${ACTIVE}, ${WS}, ${SPACE}, 'concept', 'flink', NULL),
      (${OLD_STALE}, ${WS}, ${SPACE}, 'concept', 'kafka', now() - interval '40 days'),
      (${FRESH_STALE}, ${WS}, ${SPACE}, 'concept', 'redis', now() - interval '5 days'),
      (${OLD_STALE_SIBLING}, ${WS}, ${SPACE}, 'entity', 'zookeeper', now() - interval '35 days'),
      (${BUSY_OLD_STALE}, ${WS}, ${BUSY_SPACE}, 'concept', 'kafka', now() - interval '40 days')
  `.execute(db);
  await sql`
    INSERT INTO knowledge_parent_sections (knowledge_page_id)
      SELECT id FROM knowledge_pages;
    INSERT INTO knowledge_chunks (knowledge_page_id, parent_section_id)
      SELECT knowledge_page_id, id FROM knowledge_parent_sections;
    INSERT INTO knowledge_chunk_sources (chunk_id, source_page_id)
      SELECT id, gen_random_uuid() FROM knowledge_chunks;
    INSERT INTO knowledge_page_sources (knowledge_page_id, source_page_id)
      SELECT id, gen_random_uuid() FROM knowledge_pages;
  `.execute(db);
  await sql`
    INSERT INTO knowledge_links VALUES
      (${ACTIVE_LINK}, ${WS}, ${SPACE}, ${ACTIVE}, ${OLD_STALE}, 'concept', 'kafka', false, NULL),
      (${STALE_LINK}, ${WS}, ${SPACE}, ${OLD_STALE_SIBLING}, ${ACTIVE}, 'concept', 'flink', false,
        now() - interval '35 days'),
      (${STALE_INBOUND_LINK}, ${WS}, ${SPACE}, ${FRESH_STALE}, ${OLD_STALE}, 'concept', 'kafka', false,
        now() - interval '5 days')
  `.execute(db);
}

async function pageIds(db: Kysely<unknown>): Promise<string[]> {
  const result = await sql<{ id: string }>`
    SELECT id FROM knowledge_pages ORDER BY id
  `.execute(db);
  return result.rows.map((row) => row.id);
}

async function linkById(db: Kysely<unknown>, id: string) {
  const result = await sql<{
    isDangling: boolean;
    toKnowledgePageId: string | null;
    targetArtifactKind: string;
    targetCanonicalKey: string;
  }>`
    SELECT is_dangling, to_knowledge_page_id, target_artifact_kind, target_canonical_key
    FROM knowledge_links WHERE id = ${id}
  `.execute(db);
  return result.rows[0];
}
