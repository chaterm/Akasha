import { PagePermissionRepo } from './page-permission.repo';
import { readFileSync } from 'fs';
import { join } from 'path';

type QueryCall = {
  method: string;
  args: unknown[];
};

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly result: unknown[] = []) {}

  withRecursive(name: string, callback: (query: this) => unknown) {
    this.calls.push({ method: 'withRecursive', args: [name] });
    callback(this);
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

  where(...args: unknown[]) {
    this.calls.push({ method: 'where', args });
    return this;
  }

  unionAll(callback: (query: this) => unknown) {
    this.calls.push({ method: 'unionAll', args: [] });
    callback(this);
    return this;
  }

  innerJoin(...args: unknown[]) {
    this.calls.push({ method: 'innerJoin', args });
    return this;
  }

  leftJoin(...args: unknown[]) {
    this.calls.push({ method: 'leftJoin', args });
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
}

function createRepo(query: FakeKyselyQuery) {
  return new PagePermissionRepo(query as never, undefined, undefined);
}

describe('PagePermissionRepo.findRestrictedAncestorRequirementsForPages', () => {
  it('returns an empty array without querying when pageIds is empty', async () => {
    const query = new FakeKyselyQuery();
    const repo = createRepo(query);

    await expect(
      repo.findRestrictedAncestorRequirementsForPages([]),
    ).resolves.toEqual([]);

    expect(query.calls).toEqual([]);
  });

  it('groups restricted ancestors and preserves zero-permission ancestors', async () => {
    const query = new FakeKyselyQuery([
      {
        sourcePageId: 'page-1',
        sourceSpaceId: 'space-1',
        pageAccessId: 'access-ancestor',
        restrictedPageId: 'ancestor',
        depth: 1,
        userId: 'user-1',
        groupId: null,
        role: 'reader',
      },
      {
        sourcePageId: 'page-1',
        sourceSpaceId: 'space-1',
        pageAccessId: 'access-ancestor',
        restrictedPageId: 'ancestor',
        depth: 1,
        userId: null,
        groupId: 'group-1',
        role: 'writer',
      },
      {
        sourcePageId: 'page-1',
        sourceSpaceId: 'space-1',
        pageAccessId: 'access-empty',
        restrictedPageId: 'empty-ancestor',
        depth: 2,
        userId: null,
        groupId: null,
        role: null,
      },
    ]);
    const repo = createRepo(query);

    await expect(
      repo.findRestrictedAncestorRequirementsForPages(['page-1']),
    ).resolves.toEqual([
      {
        sourcePageId: 'page-1',
        sourceSpaceId: 'space-1',
        restrictedAncestors: [
          {
            pageAccessId: 'access-ancestor',
            restrictedPageId: 'ancestor',
            depth: 1,
            permissions: [
              { userId: 'user-1', groupId: null, role: 'reader' },
              { userId: null, groupId: 'group-1', role: 'writer' },
            ],
          },
          {
            pageAccessId: 'access-empty',
            restrictedPageId: 'empty-ancestor',
            depth: 2,
            permissions: [],
          },
        ],
      },
    ]);
  });

  it('does not use an unquoted mixed-case recursive alias in raw SQL fragments', async () => {
    const repoSource = readFileSync(
      join(__dirname, 'page-permission.repo.ts'),
      'utf8',
    );

    expect(repoSource).not.toContain('`allAncestors.depth + 1`');
  });
});
