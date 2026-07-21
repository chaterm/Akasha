import { KnowledgeCompilationRepo } from './knowledge-compilation.repo';

type QueryCall = { method: string; args: unknown[] };

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly result: unknown[] = []) {}

  insertInto(...args: unknown[]) {
    this.calls.push({ method: 'insertInto', args });
    return this;
  }

  values(...args: unknown[]) {
    this.calls.push({ method: 'values', args });
    return this;
  }

  onConflict(...args: unknown[]) {
    this.calls.push({ method: 'onConflict', args });
    return this;
  }

  updateTable(...args: unknown[]) {
    this.calls.push({ method: 'updateTable', args });
    return this;
  }

  set(...args: unknown[]) {
    this.calls.push({ method: 'set', args });
    return this;
  }

  selectFrom(...args: unknown[]) {
    this.calls.push({ method: 'selectFrom', args });
    return this;
  }

  select(...args: unknown[]) {
    this.calls.push({ method: 'select', args });
    return this;
  }

  selectAll(...args: unknown[]) {
    this.calls.push({ method: 'selectAll', args });
    return this;
  }

  where(...args: unknown[]) {
    this.calls.push({ method: 'where', args });
    return this;
  }

  orderBy(...args: unknown[]) {
    this.calls.push({ method: 'orderBy', args });
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.result;
  }

  async executeTakeFirst() {
    this.calls.push({ method: 'executeTakeFirst', args: [] });
    return this.result[0];
  }
}

describe('KnowledgeCompilationRepo', () => {
  it('starts a page attempt without clearing the last successful version', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);

    await repo.startAttempt({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v2',
      sourceContentHash: 'hash-2',
      compilerVersion: 'compiler-v2',
      promptVersion: 'prompt-v2',
      compilerRunId: 'run-2',
      compileTaskId: 'task-page-1',
    });

    const persisted = JSON.stringify(query.calls);
    expect(persisted).toContain('knowledgeCompilationAttempts');
    expect(persisted).toContain('hash-2');
    expect(persisted).not.toContain('lastSuccessfulSourceVersion');
    expect(query.calls).toContainEqual({
      method: 'onConflict',
      args: [expect.any(Function)],
    });
  });

  it('records a sanitized failure without overwriting last-success fields', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);

    await repo.failAttempt({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      stage: 'generation',
      errorCode: 'invalid_output',
      errorMessage: 'Generated JSON did not match the schema.',
    });

    const setCall = query.calls.find((call) => call.method === 'set');
    expect(setCall?.args[0]).toEqual(
      expect.objectContaining({
        status: 'failed',
        stage: 'generation',
        errorCode: 'invalid_output',
        errorMessage: 'Generated JSON did not match the schema.',
        finishedAt: expect.any(Date),
      }),
    );
    expect(setCall?.args[0]).not.toHaveProperty('lastSuccessfulSourceVersion');
    expect(JSON.stringify(setCall)).not.toContain('private source text');
  });

  it('records the current source as the last successful version', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);

    await repo.succeedAttempt({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v2',
      sourceContentHash: 'hash-2',
    });

    expect(query.calls.find((call) => call.method === 'set')?.args[0]).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        stage: 'completed',
        lastSuccessfulSourceVersion: 'v2',
        lastSuccessfulSourceHash: 'hash-2',
        lastSucceededAt: expect.any(Date),
      }),
    );
  });

  it('looks up Stage 1 analysis by the complete cache key', async () => {
    const analysis = { synopsis: 'A typed analysis' };
    const query = new FakeKyselyQuery([{ analysis }]);
    const repo = new KnowledgeCompilationRepo(query as never);

    await expect(
      repo.findAnalysis({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-1',
        sourceContentHash: 'hash-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
    ).resolves.toEqual(analysis);

    expect(query.calls.filter((call) => call.method === 'where')).toEqual([
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', '=', 'page-1'] },
      { method: 'where', args: ['sourceContentHash', '=', 'hash-1'] },
      { method: 'where', args: ['compilerVersion', '=', 'compiler-v1'] },
      { method: 'where', args: ['promptVersion', '=', 'prompt-v1'] },
    ]);
  });

  it('returns page diagnostics for the requested workspace pages', async () => {
    const row = { sourcePageId: 'page-1', status: 'failed' };
    const query = new FakeKyselyQuery([row]);
    const repo = new KnowledgeCompilationRepo(query as never);

    await expect(
      repo.findDiagnosticsByPageIds({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1'],
      }),
    ).resolves.toEqual([row]);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeCompilationAttempts'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', 'in', ['page-1']] },
      { method: 'orderBy', args: ['updatedAt', 'desc'] },
      { method: 'execute', args: [] },
    ]);
  });
});
