import { KnowledgeQuarantineRepo } from './knowledge-quarantine.repo';

type QueryCall = {
  method: string;
  args: unknown[];
};

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

  limit(...args: unknown[]) {
    this.calls.push({ method: 'limit', args });
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.result;
  }
}

describe('KnowledgeQuarantineRepo', () => {
  it('records generic quarantine diagnostics without raw artifact content', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeQuarantineRepo(query as never);

    await repo.recordQuarantinedArtifacts({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      artifacts: [
        {
          artifactId: 'artifact-1',
          artifactKind: 'source_summary',
          compilerRunId: 'run-1',
          compileTaskId: 'task-1',
          reasonCodes: [
            'artifact_source_range_invalid',
            'artifact_quote_hash_mismatch',
          ],
          title: 'Private roadmap',
          contentMarkdown: 'Private launch plan: revenue migration dates.',
          inputSourceRefs: [{ sourcePageId: 'source-secret-1' }],
        } as never,
      ],
    });

    expect(query.calls).toEqual([
      { method: 'insertInto', args: ['knowledgeQuarantinedArtifacts'] },
      {
        method: 'values',
        args: [
          [
            {
              workspaceId: 'workspace-1',
              spaceId: 'space-1',
              artifactId: 'artifact-1',
              artifactKind: 'source_summary',
              compilerRunId: 'run-1',
              compileTaskId: 'task-1',
              reasonCodes: [
                'artifact_source_range_invalid',
                'artifact_quote_hash_mismatch',
              ],
            },
          ],
        ],
      },
      { method: 'execute', args: [] },
    ]);
    const persistedPayload = JSON.stringify(query.calls);
    expect(persistedPayload).not.toContain('Private launch plan');
    expect(persistedPayload).not.toContain('Private roadmap');
    expect(persistedPayload).not.toContain('source-secret-1');
  });

  it('skips writes when there are no quarantined artifacts', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeQuarantineRepo(query as never);

    await repo.recordQuarantinedArtifacts({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
      artifacts: [],
    });

    expect(query.calls).toEqual([]);
  });

  it('loads recent quarantine diagnostics for admin panels', async () => {
    const createdAt = new Date('2026-06-18T08:00:00.000Z');
    const query = new FakeKyselyQuery([
      {
        id: 'quarantine-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        artifactId: 'artifact-1',
        artifactKind: 'source_summary',
        compilerRunId: 'run-1',
        compileTaskId: 'task-1',
        reasonCodes: ['artifact_source_range_invalid'],
        createdAt,
      },
    ]);
    const repo = new KnowledgeQuarantineRepo(query as never);

    await expect(
      repo.findRecentByWorkspace({ workspaceId: 'workspace-1', limit: 20 }),
    ).resolves.toEqual([
      {
        id: 'quarantine-1',
        workspaceId: 'workspace-1',
        spaceId: 'space-1',
        artifactId: 'artifact-1',
        artifactKind: 'source_summary',
        compilerRunId: 'run-1',
        compileTaskId: 'task-1',
        reasonCodes: ['artifact_source_range_invalid'],
        createdAt,
      },
    ]);
    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeQuarantinedArtifacts'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'orderBy', args: ['createdAt', 'desc'] },
      { method: 'limit', args: [20] },
      { method: 'execute', args: [] },
    ]);
  });
});
