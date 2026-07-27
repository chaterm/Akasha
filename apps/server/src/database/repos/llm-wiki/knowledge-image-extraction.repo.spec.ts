import { KnowledgeImageExtractionRepo } from './knowledge-image-extraction.repo';

type QueryCall = { method: string; args: unknown[] };

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];
  private resultIndex = 0;

  constructor(private readonly results: unknown[] = []) {}

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
  insertInto(...args: unknown[]) {
    return this.chain('insertInto', args);
  }
  updateTable(...args: unknown[]) {
    return this.chain('updateTable', args);
  }
  values(...args: unknown[]) {
    return this.chain('values', args);
  }
  set(...args: unknown[]) {
    return this.chain('set', args);
  }
  onConflict(...args: unknown[]) {
    return this.chain('onConflict', args);
  }
  returningAll(...args: unknown[]) {
    return this.chain('returningAll', args);
  }
  async executeTakeFirst() {
    this.calls.push({ method: 'executeTakeFirst', args: [] });
    return this.results[this.resultIndex++];
  }
}

class FakeConflictBuilder {
  readonly calls: QueryCall[] = [];
  columns(...args: unknown[]) {
    this.calls.push({ method: 'columns', args });
    return this;
  }
  doUpdateSet(...args: unknown[]) {
    this.calls.push({ method: 'doUpdateSet', args });
    return this;
  }
  where(...args: unknown[]) {
    this.calls.push({ method: 'where', args });
    return this;
  }
}

function executeConflictCallback(query: FakeKyselyQuery) {
  const callback = query.calls.find((call) => call.method === 'onConflict')
    ?.args[0] as ((builder: FakeConflictBuilder) => unknown) | undefined;
  const builder = new FakeConflictBuilder();
  callback?.(builder);
  return builder.calls;
}

const cacheKey = {
  workspaceId: 'workspace-1',
  attachmentId: 'attachment-1',
  cacheFingerprint: 'sha256:vision-config-and-image',
  contentHash: 'sha256:image-content',
  model: 'qwen3.7-plus',
  promptVersion: 'image-understanding-v1',
};

describe('KnowledgeImageExtractionRepo', () => {
  it('finds a cached extraction only by the workspace attachment fingerprint', async () => {
    const row = { id: 'extraction-1', status: 'ready' };
    const query = new FakeKyselyQuery([row]);
    const repo = new KnowledgeImageExtractionRepo(query as never);

    await expect(repo.findCached(cacheKey)).resolves.toEqual(row);
    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeImageExtractions'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['attachmentId', '=', 'attachment-1'] },
      {
        method: 'where',
        args: ['cacheFingerprint', '=', 'sha256:vision-config-and-image'],
      },
      { method: 'executeTakeFirst', args: [] },
    ]);
  });

  it('atomically claims a new extraction with a lease', async () => {
    const query = new FakeKyselyQuery([
      {
        id: 'extraction-1',
        status: 'processing',
        leaseToken: expect.any(String),
      },
    ]);
    const repo = new KnowledgeImageExtractionRepo(query as never);

    // Make the fake result carry the generated token written by values().
    const resultPromise = repo.claim(cacheKey, 150_000);
    const values = query.calls.find((call) => call.method === 'values')
      ?.args[0] as Record<string, unknown>;
    (query as any).results[0].leaseToken = values.leaseToken;

    await expect(resultPromise).resolves.toMatchObject({
      state: 'claimed',
      leaseToken: values.leaseToken,
    });
    expect(values).toEqual(
      expect.objectContaining({
        ...cacheKey,
        status: 'processing',
        leaseToken: expect.any(String),
        attemptCount: 1,
      }),
    );
    expect(executeConflictCallback(query)).toEqual([
      {
        method: 'columns',
        args: [['workspaceId', 'attachmentId', 'cacheFingerprint']],
      },
      { method: 'doUpdateSet', args: [expect.any(Object)] },
      { method: 'where', args: [expect.any(Object)] },
    ]);
  });

  it('returns the winner when another worker already completed the key', async () => {
    const ready = { id: 'extraction-1', status: 'ready', leaseToken: null };
    const query = new FakeKyselyQuery([undefined, ready]);
    const repo = new KnowledgeImageExtractionRepo(query as never);

    await expect(repo.claim(cacheKey, 150_000)).resolves.toEqual({
      state: 'ready',
      extraction: ready,
    });
  });

  it('publishes success only while holding the matching processing lease', async () => {
    const ready = { id: 'extraction-1', status: 'ready' };
    const query = new FakeKyselyQuery([ready]);
    const repo = new KnowledgeImageExtractionRepo(query as never);

    await expect(
      repo.completeSuccess({
        extractionId: 'extraction-1',
        leaseToken: 'lease-1',
        ocrText: '部署状态：成功',
        caption: '控制台显示部署成功。',
        mimeType: 'image/png',
        fileName: 'deployment.webp',
      }),
    ).resolves.toEqual(ready);

    expect(query.calls).toEqual([
      { method: 'updateTable', args: ['knowledgeImageExtractions'] },
      {
        method: 'set',
        args: [
          expect.objectContaining({
            status: 'ready',
            leaseToken: null,
            leaseExpiresAt: null,
            retryable: null,
            ocrText: '部署状态：成功',
          }),
        ],
      },
      { method: 'where', args: ['id', '=', 'extraction-1'] },
      { method: 'where', args: ['status', '=', 'processing'] },
      { method: 'where', args: ['leaseToken', '=', 'lease-1'] },
      { method: 'returningAll', args: [] },
      { method: 'executeTakeFirst', args: [] },
    ]);
  });

  it('stores a retryable failure with shared backoff under the lease', async () => {
    const failed = { id: 'extraction-1', status: 'failed' };
    const query = new FakeKyselyQuery([failed]);
    const repo = new KnowledgeImageExtractionRepo(query as never);
    const retryAfter = new Date('2026-07-27T00:02:00.000Z');

    await expect(
      repo.completeFailure({
        extractionId: 'extraction-1',
        leaseToken: 'lease-1',
        errorCode: 'timeout',
        errorMessage: 'The provider timed out.',
        retryable: true,
        retryAfter,
      }),
    ).resolves.toEqual(failed);

    expect(query.calls).toContainEqual({
      method: 'set',
      args: [
        expect.objectContaining({
          status: 'failed',
          retryable: true,
          retryAfter,
          leaseToken: null,
        }),
      ],
    });
  });
});
