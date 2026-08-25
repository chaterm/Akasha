import { AiChatRepo } from './ai-chat.repo';

type QueryCall = { method: string; args: unknown[] };

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly rows: unknown[]) {}

  private chain(method: string, args: unknown[]) {
    this.calls.push({ method, args });
    return this;
  }

  selectFrom(...args: unknown[]) {
    return this.chain('selectFrom', args);
  }

  selectAll(...args: unknown[]) {
    return this.chain('selectAll', args);
  }

  where(...args: unknown[]) {
    return this.chain('where', args);
  }

  orderBy(...args: unknown[]) {
    return this.chain('orderBy', args);
  }

  limit(...args: unknown[]) {
    return this.chain('limit', args);
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.rows;
  }
}

class ScriptedKysely {
  readonly calls: QueryCall[] = [];

  constructor(
    private readonly takeFirstResults: unknown[],
    private readonly executeResults: unknown[],
  ) {}

  transaction() {
    this.calls.push({ method: 'transaction', args: [] });
    return {
      execute: async (callback: (trx: ScriptedKysely) => Promise<unknown>) => {
        this.calls.push({ method: 'transaction.execute', args: [] });
        return callback(this);
      },
    };
  }

  private chain(method: string, args: unknown[]) {
    this.calls.push({ method, args });
    return this;
  }

  selectFrom(...args: unknown[]) {
    return this.chain('selectFrom', args);
  }

  select(...args: unknown[]) {
    return this.chain('select', args);
  }

  selectAll(...args: unknown[]) {
    return this.chain('selectAll', args);
  }

  updateTable(...args: unknown[]) {
    return this.chain('updateTable', args);
  }

  insertInto(...args: unknown[]) {
    return this.chain('insertInto', args);
  }

  set(...args: unknown[]) {
    return this.chain('set', args);
  }

  values(...args: unknown[]) {
    return this.chain('values', args);
  }

  returningAll(...args: unknown[]) {
    return this.chain('returningAll', args);
  }

  where(...args: unknown[]) {
    return this.chain('where', args);
  }

  orderBy(...args: unknown[]) {
    return this.chain('orderBy', args);
  }

  limit(...args: unknown[]) {
    return this.chain('limit', args);
  }

  forUpdate(...args: unknown[]) {
    return this.chain('forUpdate', args);
  }

  async executeTakeFirst() {
    this.calls.push({ method: 'executeTakeFirst', args: [] });
    return this.takeFirstResults.shift();
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.executeResults.shift() ?? [];
  }
}

describe('AiChatRepo', () => {
  it('loads the latest 20 messages from a longer chat and returns them chronologically', async () => {
    const newestFirst = Array.from({ length: 20 }, (_, index) => {
      const turn = 22 - index;
      return {
        id: `message-${`${turn}`.padStart(2, '0')}`,
        content: `turn-${turn}`,
        tsv: 'ignored',
      };
    });
    const query = new FakeKyselyQuery(newestFirst);
    const repo = new AiChatRepo(query as never);

    const messages = await repo.findMessages({
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      limit: 20,
    });

    expect(messages.map((message) => message.content)).toEqual(
      Array.from({ length: 20 }, (_, index) => `turn-${index + 3}`),
    );
    expect(messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ tsv: 'ignored' })]),
    );
    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['aiChatMessages'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['chatId', '=', 'chat-1'] },
      { method: 'where', args: ['deletedAt', 'is', null] },
      { method: 'orderBy', args: ['createdAt', 'desc'] },
      { method: 'orderBy', args: ['id', 'desc'] },
      { method: 'limit', args: [20] },
      { method: 'execute', args: [] },
    ]);
  });

  it('edits an owned user message, soft-deletes its tail, and returns the active prefix', async () => {
    const createdAt = new Date('2026-07-30T08:00:00.000Z');
    const updatedAt = new Date('2026-07-30T08:05:00.000Z');
    const target = {
      id: 'message-user-2',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'user',
      content: 'old question',
      metadata: { spaceIds: ['space-1'] },
      toolCalls: null,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
      tsv: 'ignored',
    };
    const edited = {
      ...target,
      content: 'edited question',
      updatedAt,
    };
    const prefixNewestFirst = [
      {
        ...target,
        id: 'message-assistant-1',
        userId: null,
        role: 'assistant',
        content: 'first answer',
        createdAt: new Date('2026-07-30T07:59:00.000Z'),
      },
      {
        ...target,
        id: 'message-user-1',
        content: 'first question',
        createdAt: new Date('2026-07-30T07:58:00.000Z'),
      },
    ];
    const db = new ScriptedKysely(
      [{ id: 'chat-1' }, target, edited, { id: 'message-user-1' }],
      [[], prefixNewestFirst, []],
    );
    const repo = new AiChatRepo(db as never);

    const result = await (
      repo as AiChatRepo & {
        editUserMessageAndSoftDeleteTail: (input: {
          workspaceId: string;
          userId: string;
          chatId: string;
          messageId: string;
          content: string;
        }) => Promise<{
          message: Record<string, unknown>;
          previousMessages: Array<Record<string, unknown>>;
        } | null>;
      }
    ).editUserMessageAndSoftDeleteTail({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      chatId: 'chat-1',
      messageId: 'message-user-2',
      content: 'edited question',
    });

    expect(result?.message).toEqual(
      expect.objectContaining({
        id: 'message-user-2',
        content: 'edited question',
        metadata: { spaceIds: ['space-1'] },
      }),
    );
    expect(result?.message).not.toHaveProperty('tsv');
    expect(result?.previousMessages.map((message) => message.id)).toEqual([
      'message-user-1',
      'message-assistant-1',
    ]);
    expect(db.calls).toEqual(
      expect.arrayContaining([
        { method: 'transaction', args: [] },
        { method: 'selectFrom', args: ['aiChats'] },
        { method: 'where', args: ['creatorId', '=', 'user-1'] },
        { method: 'selectFrom', args: ['aiChatMessages'] },
        { method: 'where', args: ['id', '=', 'message-user-2'] },
        { method: 'where', args: ['userId', '=', 'user-1'] },
        { method: 'where', args: ['role', '=', 'user'] },
        { method: 'forUpdate', args: [] },
        { method: 'updateTable', args: ['aiChatMessages'] },
        {
          method: 'set',
          args: [expect.objectContaining({ content: 'edited question' })],
        },
        {
          method: 'set',
          args: [
            expect.objectContaining({
              deletedAt: expect.any(Date),
              updatedAt: expect.any(Date),
            }),
          ],
        },
      ]),
    );
  });

  it('persists an assistant answer only while its user-message anchor is current', async () => {
    const anchorUpdatedAt = new Date('2026-07-30T08:05:00.000Z');
    const anchor = {
      id: 'message-user-2',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'user',
      content: 'edited question',
      metadata: null,
      toolCalls: null,
      createdAt: new Date('2026-07-30T08:00:00.000Z'),
      updatedAt: anchorUpdatedAt,
      deletedAt: null,
      tsv: null,
    };
    const assistant = {
      ...anchor,
      id: 'message-assistant-2',
      userId: null,
      role: 'assistant',
      content: 'new answer',
      createdAt: new Date('2026-07-30T08:06:00.000Z'),
      updatedAt: new Date('2026-07-30T08:06:00.000Z'),
      tsv: 'ignored',
    };
    const db = new ScriptedKysely([{ id: 'chat-1' }, anchor, assistant], [[]]);
    const repo = new AiChatRepo(db as never);

    const result = await (
      repo as AiChatRepo & {
        addAssistantMessageIfCurrent: (input: {
          workspaceId: string;
          userId: string;
          chatId: string;
          anchorMessageId: string;
          anchorUpdatedAt: Date;
          content: string;
          metadata: Record<string, unknown>;
        }) => Promise<Record<string, unknown> | null>;
      }
    ).addAssistantMessageIfCurrent({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      chatId: 'chat-1',
      anchorMessageId: 'message-user-2',
      anchorUpdatedAt,
      content: 'new answer',
      metadata: { answerMode: 'knowledge' },
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: 'message-assistant-2',
        content: 'new answer',
      }),
    );
    expect(result).not.toHaveProperty('tsv');
    expect(db.calls).toEqual(
      expect.arrayContaining([
        { method: 'where', args: ['creatorId', '=', 'user-1'] },
        { method: 'where', args: ['id', '=', 'message-user-2'] },
        { method: 'where', args: ['updatedAt', '=', anchorUpdatedAt] },
        { method: 'insertInto', args: ['aiChatMessages'] },
        {
          method: 'values',
          args: [
            expect.objectContaining({
              role: 'assistant',
              userId: null,
              content: 'new answer',
            }),
          ],
        },
      ]),
    );
    expect(db.calls).not.toContainEqual({
      method: 'updateTable',
      args: ['aiChats'],
    });
  });

  it('persists the current edited answer without a second tail scan or delete', async () => {
    const anchorUpdatedAt = new Date('2026-07-30T08:05:00.000Z');
    const anchor = {
      id: 'message-user-2',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'user',
      content: 'edited question',
      metadata: null,
      toolCalls: null,
      createdAt: new Date('2026-07-30T08:00:00.000Z'),
      updatedAt: anchorUpdatedAt,
      deletedAt: null,
      tsv: null,
    };
    const assistant = {
      ...anchor,
      id: 'message-assistant-new',
      userId: null,
      role: 'assistant',
      content: 'new answer',
      createdAt: new Date('2026-07-30T08:06:00.000Z'),
      updatedAt: new Date('2026-07-30T08:06:00.000Z'),
    };
    const db = new ScriptedKysely([{ id: 'chat-1' }, anchor, assistant], [[]]);
    const repo = new AiChatRepo(db as never);

    const result = await repo.addAssistantMessageIfCurrent({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      chatId: 'chat-1',
      anchorMessageId: 'message-user-2',
      anchorUpdatedAt,
      content: 'new answer',
      metadata: { answerMode: 'knowledge' },
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        id: 'message-assistant-new',
        content: 'new answer',
      }),
    );
    expect(db.calls).toContainEqual({
      method: 'insertInto',
      args: ['aiChatMessages'],
    });
    expect(db.calls).not.toContainEqual({
      method: 'updateTable',
      args: ['aiChatMessages'],
    });
    expect(
      db.calls.filter(
        (call) =>
          call.method === 'selectFrom' && call.args[0] === 'aiChatMessages',
      ),
    ).toHaveLength(1);
  });
});
