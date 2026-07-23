import { KnowledgeAccessPolicyRepo } from './knowledge-access-policy.repo';

type QueryCall = {
  method: string;
  args: unknown[];
};

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(
    private readonly results: unknown[] | Record<string, unknown[]> = [],
  ) {}

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

  returningAll(...args: unknown[]) {
    this.calls.push({ method: 'returningAll', args });
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

  updateTable(...args: unknown[]) {
    this.calls.push({ method: 'updateTable', args });
    return this;
  }

  deleteFrom(...args: unknown[]) {
    this.calls.push({ method: 'deleteFrom', args });
    return this;
  }

  set(...args: unknown[]) {
    this.calls.push({ method: 'set', args });
    return this;
  }

  where(...args: unknown[]) {
    this.calls.push({ method: 'where', args });
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.resultForLastTable();
  }

  async executeTakeFirstOrThrow() {
    this.calls.push({ method: 'executeTakeFirstOrThrow', args: [] });
    return this.resultForLastTable()[0];
  }

  private resultForLastTable(): unknown[] {
    if (Array.isArray(this.results)) return this.results;

    const lastTableCall = [...this.calls]
      .reverse()
      .find((call) =>
        ['selectFrom', 'updateTable', 'insertInto', 'deleteFrom'].includes(
          call.method,
        ),
      );
    return this.results[String(lastTableCall?.args[0])] ?? [];
  }
}

function createRepo(query: FakeKyselyQuery) {
  return new KnowledgeAccessPolicyRepo(query as never);
}

describe('KnowledgeAccessPolicyRepo', () => {
  it('upserts policies into the knowledgeSourceAccessPolicy table', async () => {
    const row = { sourcePageId: 'page-1', workspaceId: 'workspace-1' };
    const query = new FakeKyselyQuery([row]);
    const repo = createRepo(query);

    await expect(
      repo.upsertPolicy({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-1',
        sourceSpaceId: 'space-1',
        policyHash: 'policy-hash',
        restrictedAncestorCount: 2,
      }),
    ).resolves.toEqual(row);

    expect(query.calls).toEqual([
      { method: 'insertInto', args: ['knowledgeSourceAccessPolicy'] },
      {
        method: 'values',
        args: [
          {
            workspaceId: 'workspace-1',
            sourcePageId: 'page-1',
            sourceSpaceId: 'space-1',
            policyHash: 'policy-hash',
            restrictedAncestorCount: 2,
            staleAt: null,
          },
        ],
      },
      { method: 'onConflict', args: [expect.any(Function)] },
      { method: 'returningAll', args: [] },
      { method: 'executeTakeFirstOrThrow', args: [] },
    ]);
  });

  it('does not query policies for an empty source list', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await expect(
      repo.findPoliciesForSources({
        workspaceId: 'workspace-1',
        sourcePageIds: [],
      }),
    ).resolves.toEqual([]);

    expect(query.calls).toEqual([]);
  });

  it('finds policies within the requested workspace', async () => {
    const rows = [{ sourcePageId: 'page-1' }];
    const query = new FakeKyselyQuery(rows);
    const repo = createRepo(query);

    await expect(
      repo.findPoliciesForSources({
        workspaceId: 'workspace-1',
        sourcePageIds: ['page-1', 'page-2'],
      }),
    ).resolves.toEqual(rows);

    expect(query.calls).toEqual([
      { method: 'selectFrom', args: ['knowledgeSourceAccessPolicy'] },
      { method: 'selectAll', args: [] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', 'in', ['page-1', 'page-2']] },
      { method: 'execute', args: [] },
    ]);
  });

  it('marks scope policies stale by workspace and source space', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await repo.markScopeStale({
      workspaceId: 'workspace-1',
      spaceId: 'space-1',
    });

    expect(query.calls).toEqual([
      { method: 'updateTable', args: ['knowledgeSourceAccessPolicy'] },
      {
        method: 'set',
        args: [expect.objectContaining({ staleAt: expect.any(Date) })],
      },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourceSpaceId', '=', 'space-1'] },
      { method: 'execute', args: [] },
    ]);
  });

  it('replaces requirements and principals for a source policy snapshot', async () => {
    const row = { sourcePageId: 'page-1', workspaceId: 'workspace-1' };
    const query = new FakeKyselyQuery([row]);
    const repo = createRepo(query);

    await expect(
      repo.replacePolicySnapshot({
        workspaceId: 'workspace-1',
        sourcePageId: 'page-1',
        sourceSpaceId: 'space-1',
        policyHash: 'hash-1',
        restrictedAncestorCount: 2,
        requirements: [
          {
            requirementId: 'access-1',
            restrictedPageId: 'restricted-1',
            depth: 0,
            principals: [
              {
                principalType: 'user',
                principalId: 'user-1',
                role: 'reader',
              },
              {
                principalType: 'group',
                principalId: 'group-1',
                role: 'writer',
              },
            ],
          },
          {
            requirementId: 'access-empty',
            restrictedPageId: 'restricted-empty',
            depth: 1,
            principals: [],
          },
        ],
      }),
    ).resolves.toEqual(row);

    expect(query.calls).toEqual([
      { method: 'deleteFrom', args: ['knowledgeSourceAccessPrincipals'] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', '=', 'page-1'] },
      { method: 'execute', args: [] },
      { method: 'deleteFrom', args: ['knowledgeSourceAccessRequirements'] },
      { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
      { method: 'where', args: ['sourcePageId', '=', 'page-1'] },
      { method: 'execute', args: [] },
      { method: 'insertInto', args: ['knowledgeSourceAccessPolicy'] },
      {
        method: 'values',
        args: [
          {
            workspaceId: 'workspace-1',
            sourcePageId: 'page-1',
            sourceSpaceId: 'space-1',
            policyHash: 'hash-1',
            restrictedAncestorCount: 2,
            staleAt: null,
          },
        ],
      },
      { method: 'onConflict', args: [expect.any(Function)] },
      { method: 'returningAll', args: [] },
      { method: 'executeTakeFirstOrThrow', args: [] },
      {
        method: 'insertInto',
        args: ['knowledgeSourceAccessRequirements'],
      },
      {
        method: 'values',
        args: [
          [
            {
              workspaceId: 'workspace-1',
              sourcePageId: 'page-1',
              requirementId: 'access-1',
              restrictedPageId: 'restricted-1',
              depth: 0,
            },
            {
              workspaceId: 'workspace-1',
              sourcePageId: 'page-1',
              requirementId: 'access-empty',
              restrictedPageId: 'restricted-empty',
              depth: 1,
            },
          ],
        ],
      },
      { method: 'execute', args: [] },
      {
        method: 'insertInto',
        args: ['knowledgeSourceAccessPrincipals'],
      },
      {
        method: 'values',
        args: [
          [
            {
              workspaceId: 'workspace-1',
              sourcePageId: 'page-1',
              requirementId: 'access-1',
              principalType: 'user',
              principalId: 'user-1',
              role: 'reader',
            },
            {
              workspaceId: 'workspace-1',
              sourcePageId: 'page-1',
              requirementId: 'access-1',
              principalType: 'group',
              principalId: 'group-1',
              role: 'writer',
            },
          ],
        ],
      },
      { method: 'execute', args: [] },
    ]);
  });

  it('evaluates sidecar source eligibility against supplied user and group principals', async () => {
    const staleAt = new Date('2026-06-16T00:00:00.000Z');
    const query = new FakeKyselyQuery({
      knowledgeSourceAccessPolicy: [
        {
          sourcePageId: 'source-open',
          sourceSpaceId: 'space-1',
          policyHash: 'hash-open',
          restrictedAncestorCount: 0,
          staleAt: null,
          updatedAt: new Date('2026-06-15T00:00:00.000Z'),
        },
        {
          sourcePageId: 'source-group',
          sourceSpaceId: 'space-1',
          policyHash: 'hash-group',
          restrictedAncestorCount: 2,
          staleAt: null,
          updatedAt: new Date('2026-06-15T00:00:00.000Z'),
        },
        {
          sourcePageId: 'source-denied',
          sourceSpaceId: 'space-1',
          policyHash: 'hash-denied',
          restrictedAncestorCount: 1,
          staleAt: null,
          updatedAt: new Date('2026-06-15T00:00:00.000Z'),
        },
        {
          sourcePageId: 'source-empty',
          sourceSpaceId: 'space-1',
          policyHash: 'hash-empty',
          restrictedAncestorCount: 1,
          staleAt: null,
          updatedAt: new Date('2026-06-15T00:00:00.000Z'),
        },
        {
          sourcePageId: 'source-stale',
          sourceSpaceId: 'space-1',
          policyHash: 'hash-stale',
          restrictedAncestorCount: 0,
          staleAt,
          updatedAt: new Date('2026-06-15T00:00:00.000Z'),
        },
      ],
      knowledgeSourceAccessRequirements: [
        {
          sourcePageId: 'source-group',
          requirementId: 'group-req-1',
        },
        {
          sourcePageId: 'source-group',
          requirementId: 'group-req-2',
        },
        {
          sourcePageId: 'source-denied',
          requirementId: 'denied-req',
        },
        {
          sourcePageId: 'source-empty',
          requirementId: 'empty-req',
        },
      ],
      knowledgeSourceAccessPrincipals: [
        {
          sourcePageId: 'source-group',
          requirementId: 'group-req-1',
          principalType: 'user',
          principalId: 'user-1',
        },
        {
          sourcePageId: 'source-group',
          requirementId: 'group-req-2',
          principalType: 'group',
          principalId: 'group-1',
        },
        {
          sourcePageId: 'source-denied',
          requirementId: 'denied-req',
          principalType: 'user',
          principalId: 'user-2',
        },
      ],
    });
    const repo = createRepo(query);

    await expect(
      repo.evaluateSourceEligibilityForPrincipals({
        workspaceId: 'workspace-1',
        sourcePageIds: [
          'source-open',
          'source-group',
          'source-denied',
          'source-empty',
          'source-stale',
          'source-missing',
        ],
        principals: [
          { principalType: 'user', principalId: 'user-1' },
          { principalType: 'group', principalId: 'group-1' },
        ],
      }),
    ).resolves.toEqual([
      {
        sourcePageId: 'source-open',
        sourceSpaceId: 'space-1',
        status: 'eligible',
        policyHash: 'hash-open',
        staleAt: null,
        updatedAt: new Date('2026-06-15T00:00:00.000Z'),
      },
      {
        sourcePageId: 'source-group',
        sourceSpaceId: 'space-1',
        status: 'eligible',
        policyHash: 'hash-group',
        staleAt: null,
        updatedAt: new Date('2026-06-15T00:00:00.000Z'),
      },
      {
        sourcePageId: 'source-denied',
        sourceSpaceId: 'space-1',
        status: 'denied_by_restricted_ancestor',
        policyHash: 'hash-denied',
        staleAt: null,
        updatedAt: new Date('2026-06-15T00:00:00.000Z'),
      },
      {
        sourcePageId: 'source-empty',
        sourceSpaceId: 'space-1',
        status: 'empty_restricted_ancestor',
        policyHash: 'hash-empty',
        staleAt: null,
        updatedAt: new Date('2026-06-15T00:00:00.000Z'),
      },
      {
        sourcePageId: 'source-stale',
        sourceSpaceId: 'space-1',
        status: 'stale_policy',
        policyHash: 'hash-stale',
        staleAt,
        updatedAt: new Date('2026-06-15T00:00:00.000Z'),
      },
      {
        sourcePageId: 'source-missing',
        sourceSpaceId: null,
        status: 'missing_policy',
      },
    ]);

    expect(query.calls).toEqual(
      expect.arrayContaining([
        { method: 'selectFrom', args: ['knowledgeSourceAccessPolicy'] },
        { method: 'selectFrom', args: ['knowledgeSourceAccessRequirements'] },
        { method: 'selectFrom', args: ['knowledgeSourceAccessPrincipals'] },
      ]),
    );
  });
});
