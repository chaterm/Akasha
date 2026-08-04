import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';
import { AiChatRepo } from './ai-chat.repo';

const databaseUrl = process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('AI chat edit PostgreSQL boundary', () => {
  const schema = `akasha_ai_chat_edit_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: AiChatRepo;

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
    repo = new AiChatRepo(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('keeps a microsecond-precision edit anchor active and persists its new answer', async () => {
    await sql`
      INSERT INTO ai_chats (id, workspace_id, creator_id, title)
      VALUES ('chat-1', 'workspace-1', 'user-1', 'Original title')
    `.execute(db);
    await sql`
      INSERT INTO ai_chat_messages
        (id, workspace_id, chat_id, user_id, role, content, created_at, updated_at)
      VALUES
        (
          'message-user-1', 'workspace-1', 'chat-1', 'user-1', 'user',
          'first question', '2026-07-30T03:44:00.000123Z',
          '2026-07-30T03:44:00.000123Z'
        ),
        (
          'message-assistant-1', 'workspace-1', 'chat-1', NULL, 'assistant',
          'first answer', '2026-07-30T03:44:10.000456Z',
          '2026-07-30T03:44:10.000456Z'
        ),
        (
          'message-user-2', 'workspace-1', 'chat-1', 'user-1', 'user',
          'old question', '2026-07-30T03:44:20.060789Z',
          '2026-07-30T03:44:20.060789Z'
        ),
        (
          'message-assistant-2', 'workspace-1', 'chat-1', NULL, 'assistant',
          'old answer', '2026-07-30T03:44:28.290123Z',
          '2026-07-30T03:44:28.290123Z'
        )
    `.execute(db);

    const result = await repo.editUserMessageAndSoftDeleteTail({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      chatId: 'chat-1',
      messageId: 'message-user-2',
      content: 'edited question',
    });
    const assistant = await repo.addAssistantMessageIfCurrent({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      chatId: 'chat-1',
      anchorMessageId: 'message-user-2',
      anchorUpdatedAt: result!.message.updatedAt,
      content: 'new answer',
      metadata: null,
    });
    const rows = await sql<{
      id: string;
      content: string;
      deletedAt: Date | null;
    }>`
      SELECT id, content, deleted_at AS "deletedAt"
      FROM ai_chat_messages
      ORDER BY created_at, id
    `.execute(db);

    expect(result).toEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          id: 'message-user-2',
          content: 'edited question',
          deletedAt: null,
        }),
      }),
    );
    expect(result?.previousMessages.map((message) => message.id)).toEqual([
      'message-user-1',
      'message-assistant-1',
    ]);
    expect(assistant).toEqual(
      expect.objectContaining({
        id: 'message-assistant-new',
        content: 'new answer',
        deletedAt: null,
      }),
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ id: 'message-user-1', deletedAt: null }),
      expect.objectContaining({ id: 'message-assistant-1', deletedAt: null }),
      expect.objectContaining({
        id: 'message-user-2',
        content: 'edited question',
        deletedAt: null,
      }),
      expect.objectContaining({
        id: 'message-assistant-2',
        deletedAt: expect.any(Date),
      }),
      expect.objectContaining({
        id: 'message-assistant-new',
        content: 'new answer',
        deletedAt: null,
      }),
    ]);
  });
});

async function createFixture(db: Kysely<unknown>) {
  await sql`
    CREATE TABLE ai_chats (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      creator_id text NOT NULL,
      title text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    )
  `.execute(db);
  await sql`
    CREATE TABLE ai_chat_messages (
      id text PRIMARY KEY DEFAULT 'message-assistant-new',
      workspace_id text NOT NULL,
      chat_id text NOT NULL,
      user_id text,
      role text NOT NULL,
      content text NOT NULL,
      metadata jsonb,
      tool_calls jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    )
  `.execute(db);
}
