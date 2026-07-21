import { KnowledgeArtifactContributionRepo } from './knowledge-artifact-contribution.repo';

type QueryCall = { method: string; args: unknown[] };

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly result: unknown[] = []) {}

  selectFrom(...args: unknown[]) {
    this.calls.push({ method: 'selectFrom', args });
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

  deleteFrom(...args: unknown[]) {
    this.calls.push({ method: 'deleteFrom', args });
    return this;
  }

  insertInto(...args: unknown[]) {
    this.calls.push({ method: 'insertInto', args });
    return this;
  }

  values(...args: unknown[]) {
    this.calls.push({ method: 'values', args });
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.result;
  }
}

describe('KnowledgeArtifactContributionRepo', () => {
  it('loads all contributions for affected canonical artifact IDs', async () => {
    const rows = [{ id: 'contribution-1', artifactId: 'artifact-1' }];
    const query = new FakeKyselyQuery(rows);
    const repo = new KnowledgeArtifactContributionRepo(query as never);

    await expect(
      repo.findByArtifactIds({
        workspaceId: 'workspace-1',
        artifactIds: ['artifact-1', 'artifact-2'],
      }),
    ).resolves.toEqual(rows);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeArtifactContributions'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      {
        method: 'where',
        args: ['artifactId', 'in', ['artifact-1', 'artifact-2']],
      },
      { method: 'orderBy', args: ['sourcePageId', 'asc'] },
      { method: 'execute', args: [] },
    ]);
  });

  it('atomically replaces the complete contribution set for one source page', async () => {
    const query = new FakeKyselyQuery();
    const repo = new KnowledgeArtifactContributionRepo(query as never);

    await repo.replaceSourceContributions({
      workspaceId: 'workspace-1',
      sourcePageId: 'page-1',
      contributions: [
        {
          id: 'contribution-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          sourcePageId: 'page-1',
          sourceVersion: 'v2',
          sourceContentHash: 'hash-2',
          artifactId: 'artifact-1',
          artifactKind: 'concept',
          canonicalKey: 'event-sourcing',
          compilerVersion: 'compiler-v1',
          promptVersion: 'prompt-v1',
          compilerRunId: 'run-2',
          compileTaskId: 'task-1',
          artifact: { title: 'Event sourcing' },
        },
      ],
    });

    expect(query.calls).toEqual([
      { method: 'deleteFrom', args: ['knowledgeArtifactContributions'] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', '=', 'page-1'] },
      { method: 'execute', args: [] },
      { method: 'insertInto', args: ['knowledgeArtifactContributions'] },
      {
        method: 'values',
        args: [
          [
            expect.objectContaining({
              artifactId: 'artifact-1',
              canonicalKey: 'event-sourcing',
              artifact: { title: 'Event sourcing' },
              updatedAt: expect.any(Date),
            }),
          ],
        ],
      },
      { method: 'execute', args: [] },
    ]);
  });
});
