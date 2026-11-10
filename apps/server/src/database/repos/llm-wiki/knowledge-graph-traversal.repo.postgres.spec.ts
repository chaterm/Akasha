import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeCapsuleRepo } from './knowledge-capsule.repo';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;

const WORKSPACE = '00000000-0000-0000-0000-00000000000a';
const SPACE_A = '00000000-0000-0000-0000-000000000a01';
const SPACE_B = '00000000-0000-0000-0000-000000000b01';
const SEED = '00000000-0000-0000-0000-000000001111';
const VIA_LINK = '00000000-0000-0000-0000-000000002222';
const VIA_SECRET_LINK = '00000000-0000-0000-0000-000000003333';
const SHARED = '00000000-0000-0000-0000-000000004444';
const OTHER_SPACE = '00000000-0000-0000-0000-000000005555';
const SRC_OPEN = '00000000-0000-0000-0000-0000000000aa';
const SRC_SECRET = '00000000-0000-0000-0000-0000000000bb';

describePostgres('graph traversal PostgreSQL behaviour', () => {
  const schema = `akasha_graph_traversal_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: KnowledgeCapsuleRepo;

  jest.setTimeout(60_000);

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
    repo = new KnowledgeCapsuleRepo(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  const traverse = (readableSourcePageIds: string[], limit = 40) =>
    repo.findGraphTraversalEdges({
      workspaceId: WORKSPACE,
      spaceIds: [SPACE_A],
      seeds: [{ knowledgePageId: SEED, weight: 0.9 }],
      readableSourcePageIds,
      limit,
    });

  it('returns link and shared-source edges with aggregated provenance', async () => {
    const edges = await traverse([SRC_OPEN, SRC_SECRET]);

    expect(edges.map((edge) => edge.type).sort()).toEqual([
      'link',
      'link',
      'shared-source',
      'shared-source',
    ]);
    const byType = new Map(edges.map((edge) => [edge.type, edge]));
    expect(byType.get('link')!.weight).toBe(0.7);
    expect(byType.get('shared-source')!.weight).toBe(0.2);
    for (const edge of edges) {
      expect(edge.sourcePageIds.length).toBeGreaterThan(0);
    }
  });

  it('excludes an edge whose provenance is not fully readable', async () => {
    const edges = await traverse([SRC_OPEN]);

    expect(edges.map((edge) => edge.type).sort()).toEqual([
      'link',
      'shared-source',
    ]);
    expect(edges.map((edge) => edge.toKnowledgePageId)).not.toContain(
      VIA_SECRET_LINK,
    );
  });

  it('judges shared-source readability on the aggregated pair, not truncated rows', async () => {
    const edges = await traverse([SRC_OPEN]);
    const sharedEdge = edges.find((edge) => edge.type === 'shared-source');

    expect(sharedEdge).toBeDefined();
    expect(sharedEdge!.sourcePageIds).toEqual([SRC_OPEN]);
    expect(sharedEdge!.toKnowledgePageId).not.toBe(SHARED);
  });

  it('never bridges across spaces even when both spaces are readable', async () => {
    const edges = await repo.findGraphTraversalEdges({
      workspaceId: WORKSPACE,
      spaceIds: [SPACE_A, SPACE_B],
      seeds: [{ knowledgePageId: SEED, weight: 0.9 }],
      readableSourcePageIds: [SRC_OPEN, SRC_SECRET],
      limit: 40,
    });

    const reached = edges.flatMap((edge) => [
      edge.fromKnowledgePageId,
      edge.toKnowledgePageId,
    ]);
    expect(reached).not.toContain(OTHER_SPACE);
  });

  it('fails closed when nothing is readable', async () => {
    expect(await traverse([])).toEqual([]);
  });

  it('keeps a reserved slot for links when shared-source could fill the limit', async () => {
    const edges = await traverse([SRC_OPEN, SRC_SECRET], 2);

    expect(edges).toHaveLength(2);
    expect(edges.some((edge) => edge.type === 'link')).toBe(true);
  });
});

const LINK_ID = '00000000-0000-0000-0000-00000000000f';
const SECRET_LINK_ID = '00000000-0000-0000-0000-00000000000e';
const CROSS_LINK_ID = '00000000-0000-0000-0000-00000000000c';

async function createFixture(db: Kysely<unknown>): Promise<void> {
  const statements = [
    sql`create table knowledge_pages (
      id uuid primary key, workspace_id uuid not null, space_id uuid not null,
      stale_at timestamptz
    )`,
    sql`create table knowledge_page_sources (
      workspace_id uuid not null, knowledge_page_id uuid not null,
      source_page_id uuid not null
    )`,
    sql`create table knowledge_links (
      id uuid primary key, workspace_id uuid not null, space_id uuid not null,
      from_knowledge_page_id uuid not null, to_knowledge_page_id uuid,
      link_type varchar not null, is_dangling boolean not null default false,
      stale_at timestamptz
    )`,
    sql`create table knowledge_link_sources (
      workspace_id uuid not null, link_id uuid not null, source_page_id uuid not null
    )`,
    sql`insert into knowledge_pages (id, workspace_id, space_id) values
      (${SEED}, ${WORKSPACE}, ${SPACE_A}),
      (${VIA_LINK}, ${WORKSPACE}, ${SPACE_A}),
      (${VIA_SECRET_LINK}, ${WORKSPACE}, ${SPACE_A}),
      (${SHARED}, ${WORKSPACE}, ${SPACE_A}),
      (${OTHER_SPACE}, ${WORKSPACE}, ${SPACE_B})`,
    sql`insert into knowledge_page_sources (workspace_id, knowledge_page_id, source_page_id) values
      (${WORKSPACE}, ${SEED}, ${SRC_OPEN}),
      (${WORKSPACE}, ${VIA_LINK}, ${SRC_OPEN}),
      (${WORKSPACE}, ${SEED}, ${SRC_SECRET}),
      (${WORKSPACE}, ${SHARED}, ${SRC_SECRET})`,
    sql`insert into knowledge_links
      (id, workspace_id, space_id, from_knowledge_page_id, to_knowledge_page_id, link_type)
      values (${LINK_ID}, ${WORKSPACE}, ${SPACE_A}, ${SEED}, ${VIA_LINK}, 'reference')`,
    sql`insert into knowledge_link_sources (workspace_id, link_id, source_page_id)
      values (${WORKSPACE}, ${LINK_ID}, ${SRC_OPEN})`,
    // Readable only when every provenance source is readable.
    sql`insert into knowledge_links
      (id, workspace_id, space_id, from_knowledge_page_id, to_knowledge_page_id, link_type)
      values (${SECRET_LINK_ID}, ${WORKSPACE}, ${SPACE_A}, ${SEED}, ${VIA_SECRET_LINK}, 'reference')`,
    sql`insert into knowledge_link_sources (workspace_id, link_id, source_page_id)
      values (${WORKSPACE}, ${SECRET_LINK_ID}, ${SRC_OPEN}), (${WORKSPACE}, ${SECRET_LINK_ID}, ${SRC_SECRET})`,
    // Claims Space A but targets a Space B page: must never be traversed.
    sql`insert into knowledge_links
      (id, workspace_id, space_id, from_knowledge_page_id, to_knowledge_page_id, link_type)
      values (${CROSS_LINK_ID}, ${WORKSPACE}, ${SPACE_A}, ${SEED}, ${OTHER_SPACE}, 'reference')`,
    sql`insert into knowledge_link_sources (workspace_id, link_id, source_page_id)
      values (${WORKSPACE}, ${CROSS_LINK_ID}, ${SRC_OPEN})`,
  ];

  for (const statement of statements) {
    await statement.execute(db);
  }
}
