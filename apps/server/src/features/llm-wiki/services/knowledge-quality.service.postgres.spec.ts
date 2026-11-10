import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeQualityService } from './knowledge-quality.service';

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('KnowledgeQualityService PostgreSQL aggregates', () => {
  const schema = `akasha_quality_${randomUUID().replaceAll('-', '')}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let service: KnowledgeQualityService;

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
    await createFixture(db);
    service = new KnowledgeQualityService(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('returns exact bounded aggregates for only the authorized Spaces', async () => {
    const report = await service.getReport({
      workspaceId: 'workspace-1',
      spaceIds: ['space-a'],
    });

    expect(report.summary).toEqual({
      pageCount: 2,
      compiledPageCount: 1,
      stalePageCount: 1,
      missingSourcePageCount: 1,
      missingChunkPageCount: 1,
      missingEmbeddingPageCount: 0,
      healthScore: 50,
    });
    expect(report.spaces).toEqual([
      expect.objectContaining({
        spaceId: 'space-a',
        spaceName: 'Space A',
        pageCount: 2,
        compiledPageCount: 1,
        stalePageCount: 1,
        healthScore: 50,
      }),
    ]);
    expect(report.topIssues.map((issue) => issue.code)).toEqual([
      'missing_chunks',
      'missing_sources',
      'stale_access_policy',
    ]);
    expect(JSON.stringify(report)).not.toContain('Space B');
  });

  it('ignores superseded and retired source rows and stale chunks', async () => {
    const report = await service.getReport({
      workspaceId: 'workspace-1',
      spaceIds: ['space-c'],
    });

    // superseded 100, stale 70, retired 100, stale-chunks 65, stale-embedding 100
    expect(report.summary).toEqual({
      pageCount: 5,
      compiledPageCount: 3,
      stalePageCount: 1,
      missingSourcePageCount: 0,
      missingChunkPageCount: 1,
      missingEmbeddingPageCount: 0,
      healthScore: 87,
    });
    expect(report.topIssues.map((issue) => issue.code)).toEqual([
      'missing_chunks',
      'stale_sources',
    ]);
    // Only the genuinely stale page contributes the oldest stale age (~3h),
    // not the superseded (2d) or retired (1d) rows.
    expect(report.spaces[0].oldestStaleSourceAgeHours).toBe(3);
  });

  it('reports a page whose source rows are all soft-deleted only as missing_sources', async () => {
    const report = await service.getReport({
      workspaceId: 'workspace-1',
      spaceIds: ['space-d'],
    });

    expect(report.summary).toEqual(
      expect.objectContaining({
        pageCount: 1,
        stalePageCount: 0,
        missingSourcePageCount: 1,
        // -35 missing source, -35 missing chunks; no -30 stale penalty
        healthScore: 30,
      }),
    );
    expect(report.spaces[0].oldestStaleSourceAgeHours).toBeNull();
  });
});

async function createFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table spaces (
      id varchar primary key,
      workspace_id varchar not null,
      name varchar not null,
      deleted_at timestamptz
    );
    create table pages (
      id varchar primary key,
      workspace_id varchar not null,
      space_id varchar not null,
      text_content text,
      deleted_at timestamptz
    );
    create table knowledge_sources (
      id varchar primary key,
      workspace_id varchar not null,
      source_page_id varchar not null,
      stale_at timestamptz,
      deleted_at timestamptz
    );
    create table knowledge_chunks (
      id varchar primary key,
      workspace_id varchar not null,
      embedding jsonb,
      stale_at timestamptz
    );
    create table knowledge_chunk_sources (
      workspace_id varchar not null,
      chunk_id varchar not null,
      source_page_id varchar not null
    );
    create table knowledge_source_access_policy (
      workspace_id varchar not null,
      source_page_id varchar not null,
      stale_at timestamptz
    );

    insert into spaces (id, workspace_id, name) values
      ('space-a', 'workspace-1', 'Space A'),
      ('space-b', 'workspace-1', 'Space B');
    insert into pages (id, workspace_id, space_id, text_content) values
      ('page-a-healthy', 'workspace-1', 'space-a', 'healthy content'),
      ('page-a-missing', 'workspace-1', 'space-a', 'missing content'),
      ('page-b-private', 'workspace-1', 'space-b', 'not authorized');
    insert into knowledge_sources (
      id, workspace_id, source_page_id, stale_at
    ) values
      ('source-a', 'workspace-1', 'page-a-healthy', null),
      ('source-b', 'workspace-1', 'page-b-private', null);
    insert into knowledge_chunks (id, workspace_id, embedding) values
      ('chunk-a', 'workspace-1', '[0.1, 0.2]'::jsonb),
      ('chunk-b', 'workspace-1', '[0.3, 0.4]'::jsonb);
    insert into knowledge_chunk_sources (
      workspace_id, chunk_id, source_page_id
    ) values
      ('workspace-1', 'chunk-a', 'page-a-healthy'),
      ('workspace-1', 'chunk-b', 'page-b-private');
    insert into knowledge_source_access_policy (
      workspace_id, source_page_id, stale_at
    ) values
      ('workspace-1', 'page-a-healthy', now() - interval '1 hour'),
      ('workspace-1', 'page-b-private', null);

    -- space-c: stale-row semantics
    insert into spaces (id, workspace_id, name) values
      ('space-c', 'workspace-1', 'Space C');
    insert into pages (id, workspace_id, space_id, text_content) values
      ('page-c-superseded', 'workspace-1', 'space-c', 'new version'),
      ('page-c-stale', 'workspace-1', 'space-c', 'changed content'),
      ('page-c-retired', 'workspace-1', 'space-c', ''),
      ('page-c-stale-chunks', 'workspace-1', 'space-c', 'recompile pending'),
      ('page-c-stale-embedding', 'workspace-1', 'space-c', 'old chunk lacks vector');
    insert into knowledge_sources (
      id, workspace_id, source_page_id, stale_at
    ) values
      ('source-c-superseded-old', 'workspace-1', 'page-c-superseded', now() - interval '2 days'),
      ('source-c-superseded-new', 'workspace-1', 'page-c-superseded', null),
      ('source-c-stale', 'workspace-1', 'page-c-stale', now() - interval '3 hours'),
      ('source-c-retired', 'workspace-1', 'page-c-retired', now() - interval '1 day'),
      ('source-c-stale-chunks', 'workspace-1', 'page-c-stale-chunks', null),
      ('source-c-stale-embedding', 'workspace-1', 'page-c-stale-embedding', null);
    insert into knowledge_chunks (id, workspace_id, embedding, stale_at) values
      ('chunk-c-superseded', 'workspace-1', '[0.1]'::jsonb, null),
      ('chunk-c-stale', 'workspace-1', '[0.1]'::jsonb, null),
      ('chunk-c-stale-only', 'workspace-1', '[0.1]'::jsonb, now() - interval '1 day'),
      ('chunk-c-active', 'workspace-1', '[0.1]'::jsonb, null),
      ('chunk-c-old-no-vector', 'workspace-1', null, now() - interval '1 day');
    insert into knowledge_chunk_sources (
      workspace_id, chunk_id, source_page_id
    ) values
      ('workspace-1', 'chunk-c-superseded', 'page-c-superseded'),
      ('workspace-1', 'chunk-c-stale', 'page-c-stale'),
      ('workspace-1', 'chunk-c-stale-only', 'page-c-stale-chunks'),
      ('workspace-1', 'chunk-c-active', 'page-c-stale-embedding'),
      ('workspace-1', 'chunk-c-old-no-vector', 'page-c-stale-embedding');

    -- space-d: every source row soft-deleted, one of them stale
    insert into spaces (id, workspace_id, name) values
      ('space-d', 'workspace-1', 'Space D');
    insert into pages (id, workspace_id, space_id, text_content) values
      ('page-d-deleted-sources', 'workspace-1', 'space-d', 'has text');
    insert into knowledge_sources (
      id, workspace_id, source_page_id, stale_at, deleted_at
    ) values
      ('source-d-stale', 'workspace-1', 'page-d-deleted-sources',
        now() - interval '1 day', now()),
      ('source-d-fresh', 'workspace-1', 'page-d-deleted-sources', null, now());
  `.execute(db);
}
