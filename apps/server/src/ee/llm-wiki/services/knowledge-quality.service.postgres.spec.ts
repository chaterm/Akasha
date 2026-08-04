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
      stale_at timestamptz
    );
    create table knowledge_chunks (
      id varchar primary key,
      workspace_id varchar not null,
      embedding jsonb
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
  `.execute(db);
}
