import { KnowledgeCompilationRepo } from './knowledge-compilation.repo';
import {
  CamelCasePlugin,
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

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

  onConflict(callback: (builder: unknown) => unknown) {
    const args = [callback];
    this.calls.push({ method: 'onConflict', args });
    callback({
      columns: (columns: unknown) => ({
        doUpdateSet: (values: unknown) => {
          this.calls.push({ method: 'doUpdateSet', args: [columns, values] });
          return this;
        },
      }),
    });
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
  it('queues a page without incrementing attempts or clearing last-success fields', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);

    await repo.queueAttempt({
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

    const valuesCall = query.calls.find((call) => call.method === 'values');
    expect(valuesCall?.args[0]).toEqual(
      expect.objectContaining({
        status: 'queued',
        stage: 'queued',
        attemptCount: 0,
        sourceVersion: 'v2',
        sourceContentHash: 'hash-2',
        startedAt: null,
        finishedAt: null,
      }),
    );
    expect(JSON.stringify(query.calls)).not.toContain(
      'lastSuccessfulSourceVersion',
    );
    expect(JSON.stringify(query.calls)).not.toContain('attempt_count + 1');
    const conflictUpdate = query.calls.find(
      (call) => call.method === 'doUpdateSet',
    );
    expect(conflictUpdate?.args[1]).not.toHaveProperty('attemptCount');
  });

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
    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['knowledgeCompilationAttempts.compileTaskId', '=', 'task-page-1'],
    });
  });

  it('qualifies the compile task fence in the PostgreSQL conflict update', async () => {
    const queries: CompiledQuery[] = [];
    const dialect = {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    };
    const db = new Kysely<Record<string, never>>({
      dialect,
      plugins: [new CamelCasePlugin()],
      log: (event) => {
        if (event.level === 'query') queries.push(event.query);
      },
    });
    const repo = new KnowledgeCompilationRepo(db as never);

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

    expect(queries[0]?.sql).toContain(
      'where "knowledge_compilation_attempts"."compile_task_id" = $',
    );
    expect(queries[0]?.sql).not.toContain('where "compile_task_id" = $');
    await db.destroy();
  });

  it('starts before source export and fills the source snapshot afterward', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);

    await repo.startAttempt({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      compilerVersion: 'compiler-v2',
      promptVersion: 'prompt-v2',
      compilerRunId: 'run-2',
      compileTaskId: 'task-page-1',
    });
    const snapshotUpdate = {
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'task-page-1',
      sourceVersion: 'v2',
      sourceContentHash: 'hash-2',
    };
    await repo.updateSourceSnapshot(snapshotUpdate);

    expect(
      query.calls.find((call) => call.method === 'values')?.args[0],
    ).toEqual(
      expect.objectContaining({
        status: 'running',
        stage: 'read_source',
        attemptCount: 1,
        sourceVersion: null,
        sourceContentHash: null,
      }),
    );
    const setCalls = query.calls.filter((call) => call.method === 'set');
    expect(setCalls[setCalls.length - 1]?.args[0]).toEqual(
      expect.objectContaining({
        sourceVersion: 'v2',
        sourceContentHash: 'hash-2',
      }),
    );
    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['compileTaskId', '=', 'task-page-1'],
    });
  });

  it('records a sanitized failure without overwriting last-success fields', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);

    const failure = {
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'task-page-1',
      stage: 'generation',
      errorCode: 'invalid_output',
      errorMessage: 'Generated JSON did not match the schema.',
    } as const;
    await repo.failAttempt(failure);

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
    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['compileTaskId', '=', 'task-page-1'],
    });
  });

  it('records a fenced skipped attempt with a sanitized reason', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);
    const skipAttempt = (
      repo as unknown as {
        skipAttempt(input: Record<string, unknown>): Promise<void>;
      }
    ).skipAttempt.bind(repo);

    await skipAttempt({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'task-page-1',
      stage: 'read_source',
      reasonCode: 'EMPTY SOURCE',
      reasonMessage: 'Knowledge source page is empty.\u0000',
    });

    expect(query.calls.find((call) => call.method === 'set')?.args[0]).toEqual(
      expect.objectContaining({
        status: 'skipped',
        stage: 'read_source',
        errorCode: 'empty_source',
        errorMessage: 'Knowledge source page is empty.',
        finishedAt: expect.any(Date),
      }),
    );
    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['compileTaskId', '=', 'task-page-1'],
    });
  });

  it('records the current source as the last successful version', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);

    const success = {
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'task-page-1',
      sourceVersion: 'v2',
      sourceContentHash: 'hash-2',
    };
    await repo.succeedAttempt(success);

    expect(query.calls.find((call) => call.method === 'set')?.args[0]).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        stage: 'completed',
        lastSuccessfulSourceVersion: 'v2',
        lastSuccessfulSourceHash: 'hash-2',
        lastSucceededAt: expect.any(Date),
      }),
    );
    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['compileTaskId', '=', 'task-page-1'],
    });
  });

  it('fences stage updates by compile task id', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);
    const stageUpdate = {
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'task-page-1',
      stage: 'generation' as const,
    };

    await repo.updateStage(stageUpdate);

    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['compileTaskId', '=', 'task-page-1'],
    });
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

  it('upserts Stage 1 analysis using the database cache-key index', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);

    await repo.saveAnalysis({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      sourceContentHash: 'hash-1',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
      analysis: { synopsis: 'Cached analysis' },
    });

    expect(
      query.calls.find((call) => call.method === 'doUpdateSet')?.args[0],
    ).toEqual([
      'workspaceId',
      'sourcePageId',
      'sourceContentHash',
      'compilerVersion',
      'promptVersion',
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
