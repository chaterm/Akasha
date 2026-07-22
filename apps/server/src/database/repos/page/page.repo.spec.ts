import { PageRepo } from './page.repo';

type QueryCall = {
  method: string;
  args: unknown[];
};

class FakeKyselyQuery {
  readonly calls: QueryCall[] = [];

  constructor(private readonly result: unknown[] = []) {}

  selectFrom(...args: unknown[]) {
    this.calls.push({ method: 'selectFrom', args });
    return this;
  }

  select(...args: unknown[]) {
    this.calls.push({ method: 'select', args });
    return this;
  }

  distinct() {
    this.calls.push({ method: 'distinct', args: [] });
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

  limit(...args: unknown[]) {
    this.calls.push({ method: 'limit', args });
    return this;
  }

  innerJoin(...args: unknown[]) {
    this.calls.push({ method: 'innerJoin', args });
    return this;
  }

  unionAll(callback: (query: this) => unknown) {
    this.calls.push({ method: 'unionAll', args: [] });
    callback(this);
    return this;
  }

  withRecursive(name: string, callback: (query: this) => unknown) {
    this.calls.push({ method: 'withRecursive', args: [name] });
    callback(this);
    return this;
  }

  async execute() {
    this.calls.push({ method: 'execute', args: [] });
    return this.result;
  }
}

function createRepo(query: FakeKyselyQuery) {
  return new PageRepo(query as never, undefined, undefined);
}

describe('PageRepo', () => {
  describe('findExistingPageRefs', () => {
    it('returns an empty array without querying when pageIds is empty', async () => {
      const query = new FakeKyselyQuery();
      const repo = createRepo(query);

      await expect(
        repo.findExistingPageRefs({ workspaceId: 'workspace-1', pageIds: [] }),
      ).resolves.toEqual([]);

      expect(query.calls).toEqual([]);
    });

    it('selects page refs in the requested workspace without filtering deleted pages', async () => {
      const deletedAt = new Date('2026-01-01T00:00:00.000Z');
      const rows = [
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          deletedAt,
        },
      ];
      const query = new FakeKyselyQuery(rows);
      const repo = createRepo(query);

      await expect(
        repo.findExistingPageRefs({
          workspaceId: 'workspace-1',
          pageIds: ['page-1', 'page-2'],
        }),
      ).resolves.toEqual(rows);

      expect(query.calls).toEqual([
        { method: 'selectFrom', args: ['pages'] },
        {
          method: 'select',
          args: [['id', 'workspaceId', 'spaceId', 'deletedAt']],
        },
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'where', args: ['id', 'in', ['page-1', 'page-2']] },
        { method: 'execute', args: [] },
      ]);
    });
  });

  describe('findSpaceIdsForPages', () => {
    it('returns distinct non-deleted space ids for pages in a workspace', async () => {
      const rows = [{ spaceId: 'space-1' }, { spaceId: 'space-2' }];
      const query = new FakeKyselyQuery(rows);
      const repo = createRepo(query);

      await expect(
        repo.findSpaceIdsForPages({
          workspaceId: 'workspace-1',
          pageIds: ['page-1', 'page-2'],
        }),
      ).resolves.toEqual(['space-1', 'space-2']);

      expect(query.calls).toEqual([
        { method: 'selectFrom', args: ['pages'] },
        { method: 'select', args: ['spaceId'] },
        { method: 'distinct', args: [] },
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'where', args: ['id', 'in', ['page-1', 'page-2']] },
        { method: 'where', args: ['deletedAt', 'is', null] },
        { method: 'execute', args: [] },
      ]);
    });

    it('returns an empty array without querying when pageIds is empty', async () => {
      const query = new FakeKyselyQuery();
      const repo = createRepo(query);

      await expect(
        repo.findSpaceIdsForPages({ workspaceId: 'workspace-1', pageIds: [] }),
      ).resolves.toEqual([]);

      expect(query.calls).toEqual([]);
    });
  });

  describe('getPageAndDescendantIds', () => {
    it('returns root and descendant ids scoped to the requested workspace', async () => {
      const query = new FakeKyselyQuery([{ id: 'root' }, { id: 'child' }]);
      const repo = createRepo(query);

      await expect(
        repo.getPageAndDescendantIds({
          rootPageId: 'root',
          workspaceId: 'workspace-1',
        }),
      ).resolves.toEqual(['root', 'child']);

      expect(query.calls).toEqual([
        { method: 'withRecursive', args: ['page_descendants'] },
        { method: 'selectFrom', args: ['pages'] },
        { method: 'select', args: [['id']] },
        { method: 'where', args: ['id', '=', 'root'] },
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'unionAll', args: [] },
        { method: 'selectFrom', args: ['pages as p'] },
        { method: 'select', args: [['p.id']] },
        {
          method: 'innerJoin',
          args: ['page_descendants as pd', 'pd.id', 'p.parentPageId'],
        },
        { method: 'where', args: ['p.workspaceId', '=', 'workspace-1'] },
        { method: 'selectFrom', args: ['page_descendants'] },
        { method: 'selectAll', args: [] },
        { method: 'execute', args: [] },
      ]);
    });
  });

  describe('findPagesForKnowledgeExport', () => {
    it('loads non-deleted page text for a workspace and space', async () => {
      const updatedAt = new Date('2026-06-16T00:00:00.000Z');
      const rows = [
        {
          id: 'page-1',
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
          title: 'Page 1',
          textContent: 'Body',
          updatedAt,
        },
      ];
      const query = new FakeKyselyQuery(rows);
      const repo = createRepo(query);

      await expect(
        repo.findPagesForKnowledgeExport({
          workspaceId: 'workspace-1',
          spaceId: 'space-1',
        }),
      ).resolves.toEqual(rows);

      expect(query.calls).toEqual([
        { method: 'selectFrom', args: ['pages'] },
        {
          method: 'select',
          args: [
            [
              'id',
              'workspaceId',
              'spaceId',
              'title',
              'textContent',
              'content',
              'updatedAt',
            ],
          ],
        },
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'where', args: ['spaceId', '=', 'space-1'] },
        { method: 'where', args: ['deletedAt', 'is', null] },
        { method: 'execute', args: [] },
      ]);
    });
  });

  describe('searchPagesInSpace', () => {
    it('searches non-deleted page titles and text inside one workspace space', async () => {
      const rows = [
        {
          id: 'page-1',
          title: '雷雨',
          textContent: '雷声越过屋檐',
          updatedAt: new Date('2026-07-22T00:00:00.000Z'),
        },
      ];
      const query = new FakeKyselyQuery(rows);
      const repo = createRepo(query);

      await expect(
        repo.searchPagesInSpace({
          workspaceId: 'workspace-1',
          spaceId: 'personal-1',
          query: '雷雨',
          limit: 5,
        }),
      ).resolves.toEqual(rows);

      expect(query.calls.slice(0, 5)).toEqual([
        { method: 'selectFrom', args: ['pages'] },
        {
          method: 'select',
          args: [['id', 'title', 'textContent', 'updatedAt']],
        },
        { method: 'where', args: ['workspaceId', '=', 'workspace-1'] },
        { method: 'where', args: ['spaceId', '=', 'personal-1'] },
        { method: 'where', args: ['deletedAt', 'is', null] },
      ]);
      expect(query.calls[5]).toEqual({
        method: 'where',
        args: [expect.anything()],
      });
      expect(query.calls.slice(6)).toEqual([
        { method: 'limit', args: [5] },
        { method: 'execute', args: [] },
      ]);
    });
  });
});
