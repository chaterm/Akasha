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
});
