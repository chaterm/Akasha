import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeCompileWindowRepo } from './knowledge-compile-window.repo';
import { nextCompileWindowStartAt } from '../../types/knowledge-compile-window.types';

// The repo evaluates the window in the server's local time; probe instants
// are chosen relative to that clock so the spec holds in any process TZ.
function localTime(hhmm: string): Date {
  const [hours, minutes] = hhmm.split(':').map(Number);
  const date = new Date(2026, 9, 28, hours, minutes, 0, 0);
  return date;
}

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('KnowledgeCompileWindowRepo PostgreSQL round trip', () => {
  const schema = `akasha_compile_window_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: KnowledgeCompileWindowRepo;

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
      create table workspaces (
        id varchar primary key,
        settings jsonb,
        deleted_at timestamptz,
        updated_at timestamptz not null default now()
      );
      insert into workspaces (id, settings)
      values ('workspace-night', '{"ai":{"chat":true,"skill":{"latestVersion":"1.0.0"}}}'::jsonb),
             ('workspace-off', null),
             ('workspace-deleted', null);
      update workspaces set deleted_at = now() where id = 'workspace-deleted';
    `.execute(db);
    repo = new KnowledgeCompileWindowRepo(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('reads an unconfigured workspace as disabled', async () => {
    await expect(repo.getConfig('workspace-off')).resolves.toEqual(
      expect.objectContaining({ enabled: false }),
    );
    await expect(repo.isEnabled('workspace-off')).resolves.toBe(false);
  });

  it('stores the window as a jsonb object without touching sibling ai settings', async () => {
    await repo.saveConfig('workspace-night', {
      enabled: true,
      startTime: '23:00',
      endTime: '07:00',
    });
    const stored = await sql<{ type: string; ai: Record<string, unknown> }>`
      select jsonb_typeof(settings->'ai'->'compileWindow') as type,
             settings->'ai' as ai
      from workspaces where id = 'workspace-night'
    `.execute(db);
    expect(stored.rows[0].type).toBe('object');
    expect(stored.rows[0].ai).toEqual({
      chat: true,
      skill: { latestVersion: '1.0.0' },
      compileWindow: {
        enabled: true,
        startTime: '23:00',
        endTime: '07:00',
      },
    });

    // Also enable the soft-deleted workspace: it must never be gated.
    await repo.saveConfig('workspace-deleted', {
      enabled: true,
      startTime: '23:00',
      endTime: '07:00',
    });
  });

  it('gates only enabled, live workspaces outside their window', async () => {
    await expect(
      repo.findGatedWorkspaceIds(localTime('12:00')),
    ).resolves.toEqual(['workspace-night']);
    await expect(
      repo.findGatedWorkspaceIds(localTime('23:30')),
    ).resolves.toEqual([]);
  });

  it('reports the next window start when deferring', async () => {
    await expect(
      repo.decide('workspace-night', localTime('12:00')),
    ).resolves.toEqual({
      deferred: true,
      deferredUntil: nextCompileWindowStartAt(
        { enabled: true, startTime: '23:00', endTime: '07:00' },
        localTime('12:00'),
      ),
    });
    expect(
      nextCompileWindowStartAt(
        { enabled: true, startTime: '23:00', endTime: '07:00' },
        localTime('12:00'),
      ),
    ).toEqual(localTime('23:00'));
    await expect(
      repo.decide('workspace-off', localTime('12:00')),
    ).resolves.toEqual({ deferred: false, deferredUntil: null });
  });
});
