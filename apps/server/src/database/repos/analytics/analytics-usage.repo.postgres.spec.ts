import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { AnalyticsUsageRepo } from './analytics-usage.repo';
import { AnalyticsUsageQueryDto } from '../../../core/analytics/dto/analytics.dto';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;
const id = (value: number) =>
  `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const WS = id(1),
  OTHER_WS = id(2),
  AGENT = id(3),
  HUMAN = id(4);
const KEY_A = id(5),
  KEY_REVOKED = id(6),
  KEY_PERSONAL = id(7);
const range = {
  workspaceId: WS,
  from: new Date('2026-11-08T16:00:00Z'),
  to: new Date('2026-11-09T16:00:00Z'),
};
const query = (values: Partial<AnalyticsUsageQueryDto> = {}) =>
  Object.assign(new AnalyticsUsageQueryDto(), values);

describePostgres('analytics usage PostgreSQL queries', () => {
  const schema = `akasha_usage_${process.pid}_${Date.now()}`;
  let db: Kysely<unknown>;
  let repo: AnalyticsUsageRepo;

  beforeAll(async () => {
    const client = postgres(normalizePostgresUrl(databaseUrl!), {
      max: 1,
      onnotice: () => {},
    });
    db = new Kysely({
      dialect: new PostgresJSDialect({ postgres: client }),
      plugins: [new CamelCasePlugin()],
    });
    await sql.raw(`create schema "${schema}"`).execute(db);
    await sql.raw(`set search_path to "${schema}"`).execute(db);
    await sql`CREATE TABLE users (id uuid PRIMARY KEY, workspace_id uuid, name text, email text, user_type text)`.execute(
      db,
    );
    await sql`CREATE TABLE api_keys (id uuid PRIMARY KEY, workspace_id uuid, name text, key_type text, creator_id uuid, deleted_at timestamptz, expires_at timestamptz)`.execute(
      db,
    );
    await sql`CREATE TABLE analytics_events (id uuid PRIMARY KEY, workspace_id uuid, user_id uuid, event text, route text, metadata jsonb, created_at timestamptz)`.execute(
      db,
    );
    await sql`INSERT INTO users VALUES (${AGENT}, ${WS}, 'Bot_100%', 'bot@example.com', 'agent'), (${HUMAN}, ${WS}, 'Alice', 'alice@example.com', 'user')`.execute(
      db,
    );
    await sql`INSERT INTO api_keys VALUES
      (${KEY_A}, ${WS}, 'Production', 'agent', ${HUMAN}, NULL, NULL),
      (${KEY_REVOKED}, ${WS}, 'Retired', 'agent', ${HUMAN}, now(), NULL),
      (${KEY_PERSONAL}, ${WS}, 'Personal', 'personal', ${HUMAN}, NULL, NULL)`.execute(
      db,
    );
    const events = [
      [AGENT, KEY_A, 'agent', 'api', 'ok', HUMAN],
      [AGENT, KEY_A, 'agent', 'api', 'error', null],
      [AGENT, KEY_REVOKED, 'agent', 'mcp', 'called', HUMAN],
      [HUMAN, KEY_PERSONAL, 'personal', 'mcp', 'called', null],
      [HUMAN, KEY_PERSONAL, 'personal', 'api', 'ok', null],
      [HUMAN, null, 'sso', 'mcp', 'called', null],
      [HUMAN, KEY_PERSONAL, null, 'mcp', 'called', null],
    ];
    for (const [
      index,
      [userId, apiKeyId, keyType, channel, outcome, delegatedUserId],
    ] of events.entries()) {
      const metadata = {
        apiKeyId,
        ...(keyType ? { keyType } : {}),
        channel,
        outcome,
        delegatedUserId,
      };
      await sql`INSERT INTO analytics_events VALUES (${id(100 + index)}, ${WS}, ${userId}, 'agent_op', ${channel === 'api' ? 'page.read' : 'mcp:get_page'}, ${metadata}::jsonb, ${new Date(range.from.getTime() + index * 3600000)})`.execute(
        db,
      );
    }
    for (const [index, workspaceId, event, time] of [
      [200, OTHER_WS, 'agent_op', range.from],
      [201, WS, 'page_view', range.from],
      [202, WS, 'agent_op', new Date(range.from.getTime() - 1)],
      [203, WS, 'agent_op', range.to],
    ] as const) {
      await sql`INSERT INTO analytics_events VALUES (${id(index)}, ${workspaceId}, ${HUMAN}, ${event}, 'other', '{"channel":"api","apiKeyId":"invalid-legacy-id"}'::jsonb, ${time})`.execute(
        db,
      );
    }
    repo = new AnalyticsUsageRepo(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('reconciles key totals, channels, zero-filled hourly buckets and endpoints', async () => {
    const result = await repo.overview(range, query());
    expect(result.summary).toEqual({
      ops: 7,
      api: 3,
      mcp: 4,
      failedOps: 1,
      unknownOps: 4,
      activeAgents: 1,
      activeUsers: 1,
      activeKeys: 3,
    });
    expect(result.total).toBe(4);
    expect(result.items.reduce((sum, row) => sum + row.ops, 0)).toBe(7);
    expect(result.daily).toHaveLength(24);
    expect(result.daily[0]).toEqual({
      date: '2026-11-09 00:00',
      api: 1,
      mcp: 0,
    });
    expect(result.daily.reduce((sum, row) => sum + row.api + row.mcp, 0)).toBe(
      7,
    );
    expect(result.byOp.reduce((sum, row) => sum + row.count, 0)).toBe(7);
    expect(result.items.find((row) => row.id === KEY_REVOKED)?.status).toBe(
      'revoked',
    );
    expect(
      result.items.find((row) => row.id === KEY_PERSONAL)?.keyTypes,
    ).toEqual(['personal']);
  });

  it('restricts the agent view and keeps detail totals consistent', async () => {
    const result = await repo.overview(range, query({ groupBy: 'agent' }));
    expect(result.summary.ops).toBe(3);
    expect(result.items).toEqual([
      expect.objectContaining({ id: AGENT, ops: 3, keyCount: 2 }),
    ]);
    const events = await repo.events(
      range,
      query({ groupBy: 'agent', entityId: AGENT }),
    );
    expect(events.total).toBe(3);
    expect(events.items).toHaveLength(3);
  });

  it('attributes agent calls to delegated users, never implicitly to key creators', async () => {
    const result = await repo.overview(range, query({ groupBy: 'user' }));
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: HUMAN, ops: 6 }),
        expect.objectContaining({ id: '__none__', ops: 1 }),
      ]),
    );
    const events = await repo.events(
      range,
      query({ groupBy: 'user', entityId: '__none__' }),
    );
    expect(events.total).toBe(1);
    expect(events.items[0]).toEqual(
      expect.objectContaining({
        actorId: AGENT,
        userId: null,
        outcome: 'error',
      }),
    );
  });

  it('applies search, credential, channel, outcome and endpoint filters to every result', async () => {
    const filter = query({
      search: 'alice@example.com',
      keyType: 'agent',
      channel: 'api',
      outcome: 'error',
      op: 'page.read',
    });
    const result = await repo.overview(range, filter);
    const events = await repo.events(range, filter);
    expect(result.summary.ops).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.daily.reduce((sum, row) => sum + row.api, 0)).toBe(1);
    expect(events.total).toBe(1);
  });

  it('searches literal wildcard characters and safely parameterizes user input', async () => {
    expect(
      (await repo.overview(range, query({ search: 'Bot_100%' }))).summary.ops,
    ).toBe(3);
    expect(
      (await repo.overview(range, query({ search: '%' }))).summary.ops,
    ).toBe(3);
    expect(
      (await repo.overview(range, query({ search: "' OR true --" }))).summary
        .ops,
    ).toBe(0);
  });

  it('paginates and sorts groups and individual calls deterministically', async () => {
    const a = await repo.overview(range, query({ limit: 1 }));
    const b = await repo.overview(range, query({ limit: 1, page: 2 }));
    expect(a.total).toBe(4);
    expect(a.items[0].id).toBe(KEY_PERSONAL);
    expect(b.items[0].id).toBe(KEY_A);
    const failures = await repo.overview(range, query({ sort: 'failedOps' }));
    expect(failures.items[0].id).toBe(KEY_A);
    const details = await repo.events(
      range,
      query({ entityId: KEY_A, limit: 1, page: 2 }),
    );
    expect(details.total).toBe(2);
    expect(details.items[0].createdAt).toBe(range.from.toISOString());
  });

  it('returns an empty result for foreign workspace entities and daily buckets for longer ranges', async () => {
    const empty = await repo.overview(range, query({ entityId: id(999) }));
    expect(empty.summary.ops).toBe(0);
    expect(empty.total).toBe(0);
    expect(empty.items).toEqual([]);
    const result = await repo.overview(
      { ...range, to: new Date(range.to.getTime() + 86400000) },
      query(),
    );
    expect(result.daily.map((row) => row.date)).toEqual([
      '2026-11-09',
      '2026-11-10',
    ]);
  });
});
