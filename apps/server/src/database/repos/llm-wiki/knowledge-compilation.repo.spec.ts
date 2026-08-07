import { KnowledgeCompilationRepo } from './knowledge-compilation.repo';
import {
  CamelCasePlugin,
  CompiledQuery,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { normalizePostgresUrl } from '../../../common/helpers';

type QueryCall = { method: string; args: unknown[] };

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly result: unknown[] = []) {}

  transaction() {
    return {
      execute: async (callback: (trx: this) => unknown) => callback(this),
    };
  }

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
      effectiveKnowledgeHash: 'effective-hash-2',
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
        effectiveKnowledgeHash: 'effective-hash-2',
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
      effectiveKnowledgeHash: 'effective-hash-2',
      compilerVersion: 'compiler-v2',
      promptVersion: 'prompt-v2',
      compilerRunId: 'run-2',
      compileTaskId: 'task-page-1',
    });

    const persisted = JSON.stringify(query.calls);
    expect(persisted).toContain('knowledgeCompilationAttempts');
    expect(persisted).toContain('hash-2');
    expect(persisted).toContain('effective-hash-2');
    expect(persisted).not.toContain('lastSuccessfulSourceVersion');
    expect(query.calls).toContainEqual({
      method: 'onConflict',
      args: [expect.any(Function)],
    });
    expect(query.calls).toContainEqual({
      method: 'where',
      args: [expect.any(Function)],
    });
  });

  it('qualifies the compile task fence and allows terminal attempts to restart in the PostgreSQL conflict update', async () => {
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
      effectiveKnowledgeHash: 'effective-hash-2',
      compilerVersion: 'compiler-v2',
      promptVersion: 'prompt-v2',
      compilerRunId: 'run-2',
      compileTaskId: 'task-page-1',
    });

    expect(queries[0]?.sql).toContain(
      'where ("knowledge_compilation_attempts"."compile_task_id" = $',
    );
    expect(queries[0]?.sql).toContain(
      '"knowledge_compilation_attempts"."status" in ($',
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
      effectiveKnowledgeHash: 'effective-hash-2',
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
        effectiveKnowledgeHash: 'effective-hash-2',
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
      effectiveKnowledgeHash: 'effective-hash-2',
    };
    await repo.succeedAttempt(success);

    expect(query.calls.find((call) => call.method === 'set')?.args[0]).toEqual(
      expect.objectContaining({
        status: 'succeeded',
        stage: 'completed',
        lastSuccessfulSourceVersion: 'v2',
        lastSuccessfulSourceHash: 'hash-2',
        effectiveKnowledgeHash: 'effective-hash-2',
        lastSuccessfulEffectiveHash: 'effective-hash-2',
        lastSucceededAt: expect.any(Date),
      }),
    );
    expect(query.calls).toContainEqual({
      method: 'where',
      args: ['compileTaskId', '=', 'task-page-1'],
    });
  });

  it('clears effective hashes when a successful attempt has no effective hash', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);

    await repo.succeedAttempt({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      compileTaskId: 'task-page-2',
      sourceVersion: 'v3',
      sourceContentHash: 'hash-3',
    });

    expect(query.calls.find((call) => call.method === 'set')?.args[0]).toEqual(
      expect.objectContaining({
        effectiveKnowledgeHash: null,
        lastSuccessfulEffectiveHash: null,
      }),
    );
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
        effectiveKnowledgeHash: 'effective-hash-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
    ).resolves.toEqual(analysis);

    expect(query.calls.filter((call) => call.method === 'where')).toEqual([
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', '=', 'page-1'] },
      {
        method: 'where',
        args: ['sourceContentHash', '=', 'effective-hash-1'],
      },
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
      effectiveKnowledgeHash: 'effective-hash-1',
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
    expect(
      (
        query.calls.find((call) => call.method === 'doUpdateSet')?.args[1] as {
          spaceId?: string;
        }
      ).spaceId,
    ).toBe('space-1');
  });

  it('does not recreate an analysis cache row when the publication fence rejects it', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeCompilationRepo(query as never);
    const publicationGuard = jest.fn().mockResolvedValue(false);

    await expect(
      repo.saveAnalysis({
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        sourcePageId: 'page-1',
        sourceVersion: 'v1',
        effectiveKnowledgeHash: 'effective-hash-1',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
        analysis: { synopsis: 'Late result' },
        publicationGuard,
      }),
    ).resolves.toBe(false);

    expect(publicationGuard).toHaveBeenCalledWith(query);
    expect(query.calls.some((call) => call.method === 'insertInto')).toBe(
      false,
    );
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

const integrationDatabaseUrl =
  process.env.AKASHA_MIGRATION_TEST_DATABASE_URL?.trim();
const describePostgres = integrationDatabaseUrl ? describe : describe.skip;

describePostgres('KnowledgeCompilationRepo PostgreSQL round trip', () => {
  const schema = `akasha_effective_hash_${process.pid}_${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: Kysely<unknown>;
  let repo: KnowledgeCompilationRepo;

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
    await createEffectiveHashFixture(db);
    repo = new KnowledgeCompilationRepo(db as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`drop schema if exists "${schema}" cascade`).execute(db);
    await db.destroy();
  });

  it('persists the current hash first and the successful hash only on success', async () => {
    const identity = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:source-1',
      effectiveKnowledgeHash: 'sha256:effective-1',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
      compilerRunId: 'run-1',
      compileTaskId: 'task-1',
    };

    await repo.queueAttempt(identity);
    await expectAttemptHashes(db, {
      current: 'sha256:effective-1',
      successful: null,
      status: 'queued',
    });

    await repo.startAttempt({
      ...identity,
      effectiveKnowledgeHash: 'sha256:effective-2',
    });
    await expectAttemptHashes(db, {
      current: 'sha256:effective-2',
      successful: null,
      status: 'running',
    });

    await repo.succeedAttempt({
      workspaceId: identity.workspaceId,
      sourcePageId: identity.sourcePageId,
      compileTaskId: identity.compileTaskId,
      sourceVersion: identity.sourceVersion,
      sourceContentHash: identity.sourceContentHash,
      effectiveKnowledgeHash: 'sha256:effective-2',
    });
    await expectAttemptHashes(db, {
      current: 'sha256:effective-2',
      successful: 'sha256:effective-2',
      status: 'succeeded',
    });

    const { effectiveKnowledgeHash: _effectiveKnowledgeHash, ...next } = {
      ...identity,
      sourceVersion: 'v2',
      sourceContentHash: 'sha256:source-2',
      compilerRunId: 'run-2',
      compileTaskId: 'task-2',
    };
    await repo.queueAttempt(next);
    await expectAttemptHashes(db, {
      current: null,
      successful: 'sha256:effective-2',
      status: 'queued',
    });
    await repo.startAttempt(next);
    await repo.succeedAttempt({
      workspaceId: next.workspaceId,
      sourcePageId: next.sourcePageId,
      compileTaskId: next.compileTaskId,
      sourceVersion: next.sourceVersion,
      sourceContentHash: next.sourceContentHash,
    });
    await expectAttemptHashes(db, {
      current: null,
      successful: null,
      status: 'succeeded',
    });
  });

  it('stores and reads Stage 1 analysis by effective knowledge hash', async () => {
    const key = {
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-1',
      sourceVersion: 'v1',
      effectiveKnowledgeHash: 'sha256:analysis-effective-1',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
    };
    await repo.saveAnalysis({ ...key, analysis: { synopsis: 'from image' } });

    await expect(repo.findAnalysis(key)).resolves.toEqual({
      synopsis: 'from image',
    });
    await expect(
      repo.findAnalysis({
        ...key,
        effectiveKnowledgeHash: 'sha256:analysis-effective-2',
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps pending import output by effective hash and clears it on success', async () => {
    await repo.startAttempt({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      sourcePageId: 'page-pending',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:source-pending',
      effectiveKnowledgeHash: 'sha256:pending-effective',
      compilerVersion: 'compiler-v1',
      promptVersion: 'prompt-v1',
      compilerRunId: 'run-pending',
      compileTaskId: 'task-pending',
    });
    await repo.savePendingImport({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-pending',
      compileTaskId: 'task-pending',
      spaceId: 'space-1',
      sourceVersion: 'v1',
      effectiveKnowledgeHash: 'sha256:pending-effective',
      preparedImport: { artifactsToPublish: ['artifact-1'] },
    });

    await expect(
      repo.findPendingImport({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-pending',
        spaceId: 'space-1',
        sourceVersion: 'v1',
        effectiveKnowledgeHash: 'sha256:pending-effective',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
    ).resolves.toEqual({ artifactsToPublish: ['artifact-1'] });
    await expect(
      repo.findPendingImport({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-pending',
        spaceId: 'space-1',
        sourceVersion: 'v1',
        effectiveKnowledgeHash: 'sha256:different',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
    ).resolves.toBeUndefined();

    await repo.succeedAttempt({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-pending',
      compileTaskId: 'task-pending',
      sourceVersion: 'v1',
      sourceContentHash: 'sha256:source-pending',
      effectiveKnowledgeHash: 'sha256:pending-effective',
    });
    await expect(
      repo.findPendingImport({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-pending',
        spaceId: 'space-1',
        sourceVersion: 'v1',
        effectiveKnowledgeHash: 'sha256:pending-effective',
        compilerVersion: 'compiler-v1',
        promptVersion: 'prompt-v1',
      }),
    ).resolves.toBeUndefined();
  });
});

async function createEffectiveHashFixture(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table knowledge_compilation_attempts (
      workspace_id varchar not null,
      space_id varchar not null,
      source_page_id varchar not null,
      source_version varchar,
      source_content_hash varchar,
      effective_knowledge_hash varchar,
      compiler_version varchar not null,
      prompt_version varchar not null,
      compiler_run_id varchar,
      compile_task_id varchar,
      status varchar not null,
      stage varchar not null,
      attempt_count integer not null,
      error_code varchar,
      error_message varchar,
      queued_at timestamptz not null,
      started_at timestamptz,
      finished_at timestamptz,
      updated_at timestamptz not null,
      last_successful_source_version varchar,
      last_successful_source_hash varchar,
      last_successful_effective_hash varchar,
      last_succeeded_at timestamptz,
      pending_import jsonb,
      pending_space_id varchar,
      pending_source_version varchar,
      pending_effective_knowledge_hash varchar,
      pending_created_at timestamptz,
      unique (workspace_id, source_page_id)
    );
    create table knowledge_source_analyses (
      workspace_id varchar not null,
      space_id varchar not null,
      source_page_id varchar not null,
      source_version varchar not null,
      source_content_hash varchar not null,
      compiler_version varchar not null,
      prompt_version varchar not null,
      analysis jsonb not null,
      updated_at timestamptz not null,
      unique (
        workspace_id, source_page_id, source_content_hash,
        compiler_version, prompt_version
      )
    )
  `.execute(db);
}

async function expectAttemptHashes(
  db: Kysely<unknown>,
  expected: {
    current: string | null;
    successful: string | null;
    status: string;
  },
): Promise<void> {
  const result = await sql<{
    current: string;
    successful: string | null;
    status: string;
  }>`
    select
      effective_knowledge_hash as "current",
      last_successful_effective_hash as "successful",
      status
    from knowledge_compilation_attempts
    where workspace_id = 'workspace-1'
      and source_page_id = 'page-1'
  `.execute(db);

  expect(result.rows).toEqual([expected]);
  if (process.env.AKASHA_MIGRATION_TEST_EVIDENCE === '1') {
    console.info(
      'knowledge_effective_hash_database_evidence',
      JSON.stringify(result.rows[0]),
    );
  }
}
