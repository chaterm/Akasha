import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { KnowledgeImageExtractionRepo } from './knowledge-image-extraction.repo';

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('KnowledgeImageExtractionRepo PostgreSQL round trip', () => {
  const schema = `akasha_image_version_${process.pid}_${Date.now()}`;
  const attachmentVersion = new Date('2026-07-28T01:00:00.000Z');
  const oldAttachmentVersion = new Date('2026-07-27T01:00:00.000Z');
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: KnowledgeImageExtractionRepo;

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
    await createFixture(db, attachmentVersion, oldAttachmentVersion);
    repo = new KnowledgeImageExtractionRepo(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('revalidates an unchanged ready cache when PostgreSQL retains sub-millisecond attachment precision', async () => {
    const snapshot = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      images: [
        {
          sourcePageId: 'page-1',
          attachmentId: 'attachment-1',
          attachmentVersion: attachmentVersion.toISOString(),
        },
      ],
      model: 'qwen3.7-plus',
      promptVersion: 'image-prompt-v1',
    };

    await expect(
      repo.findCurrentReadyForSnapshotImages(snapshot),
    ).resolves.toEqual([]);
    logEvidence('before_revalidation', await extractionEvidence(db));

    const claim = await repo.claim(
      {
        workspaceId: 'workspace-1',
        attachmentId: 'attachment-1',
        attachmentVersion,
        cacheFingerprint: 'sha256:same-image-and-config',
        contentHash: 'sha256:same-image-bytes',
        model: 'qwen3.7-plus',
        promptVersion: 'image-prompt-v1',
      },
      150_000,
    );

    expect(claim.state).toBe('ready');
    const current = await repo.findCurrentReadyForSnapshotImages(snapshot);
    expect(current).toHaveLength(1);
    expect(current[0]).toEqual(
      expect.objectContaining({
        id: 'ready-same-fingerprint',
        attachmentVersion,
        currentAttachmentVersion: attachmentVersion,
        ocrText: '数据库连接成功',
        attemptCount: 1,
      }),
    );

    const evidence = await extractionEvidence(db);
    expect(evidence).toEqual([
      {
        id: 'legacy-null-version',
        attachmentVersion: null,
        status: 'ready',
        ocrText: '旧缓存',
        attemptCount: 1,
      },
      {
        id: 'ready-same-fingerprint',
        attachmentVersion,
        status: 'ready',
        ocrText: '数据库连接成功',
        attemptCount: 1,
      },
    ]);
    logEvidence('after_revalidation', evidence);
  });
});

async function createFixture(
  db: Kysely<unknown>,
  attachmentVersion: Date,
  oldAttachmentVersion: Date,
): Promise<void> {
  await sql`
    create table attachments (
      id varchar primary key,
      workspace_id varchar not null,
      space_id varchar,
      page_id varchar,
      updated_at timestamptz not null,
      deleted_at timestamptz
    );
    create table knowledge_image_extractions (
      id varchar primary key,
      workspace_id varchar not null,
      attachment_id varchar not null references attachments(id) on delete cascade,
      attachment_version timestamptz,
      cache_fingerprint varchar not null,
      content_hash varchar not null,
      model varchar not null,
      prompt_version varchar not null,
      status varchar not null,
      mime_type varchar,
      file_name varchar,
      ocr_text text,
      caption text,
      error_code varchar,
      error_message text,
      lease_token varchar,
      lease_expires_at timestamptz,
      retryable boolean,
      retry_after timestamptz,
      attempt_count integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (workspace_id, attachment_id, cache_fingerprint)
    )
  `.execute(db);
  await sql`
    insert into attachments (
      id, workspace_id, space_id, page_id, updated_at
    ) values (
      'attachment-1', 'workspace-1', 'space-1', 'page-1',
      '2026-07-28T01:00:00.000321Z'::timestamptz
    )
  `.execute(db);
  await sql`
    insert into knowledge_image_extractions (
      id, workspace_id, attachment_id, attachment_version,
      cache_fingerprint, content_hash, model, prompt_version,
      status, ocr_text, caption, attempt_count, updated_at
    ) values
      (
        'legacy-null-version', 'workspace-1', 'attachment-1', null,
        'sha256:legacy', 'sha256:legacy-bytes', 'qwen3.7-plus',
        'image-prompt-v1', 'ready', '旧缓存', '', 1,
        '2026-07-28T03:00:00.000Z'
      ),
      (
        'ready-same-fingerprint', 'workspace-1', 'attachment-1',
        ${oldAttachmentVersion}, 'sha256:same-image-and-config',
        'sha256:same-image-bytes', 'qwen3.7-plus', 'image-prompt-v1',
        'ready', '数据库连接成功', '控制台状态正常', 1,
        '2026-07-28T02:00:00.000Z'
      )
  `.execute(db);
}

async function extractionEvidence(db: Kysely<unknown>) {
  const result = await sql<{
    id: string;
    attachmentVersion: Date | null;
    status: string;
    ocrText: string | null;
    attemptCount: number;
  }>`
    select
      id,
      attachment_version as "attachmentVersion",
      status,
      ocr_text as "ocrText",
      attempt_count as "attemptCount"
    from knowledge_image_extractions
    order by id
  `.execute(db);
  return result.rows;
}

function logEvidence(stage: string, evidence: unknown): void {
  if (process.env.AKASHA_MIGRATION_TEST_EVIDENCE !== '1') return;
  console.info(
    'knowledge_image_version_database_evidence',
    JSON.stringify({ stage, evidence }),
  );
}
