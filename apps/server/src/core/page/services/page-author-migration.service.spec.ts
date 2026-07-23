import { PageAuthorMigrationService } from './page-author-migration.service';

type FixtureRows = Record<'pages' | 'fileTasks' | 'users', any[]>;

function createSubject(rows: Partial<FixtureRows> = {}) {
  const fixtures: FixtureRows = {
    pages: rows.pages || [],
    fileTasks: rows.fileTasks || [],
    users: rows.users || [],
  };
  const updateSets: any[] = [];
  const db = {
    selectFrom: jest.fn((table: keyof FixtureRows) => {
      const query: any = {
        select: jest.fn(() => query),
        where: jest.fn(() => query),
        execute: jest.fn().mockResolvedValue(fixtures[table]),
      };
      return query;
    }),
    updateTable: jest.fn(() => {
      const query: any = {
        set: jest.fn((value) => {
          updateSets.push(value);
          return query;
        }),
        where: jest.fn(() => query),
        executeTakeFirst: jest.fn().mockResolvedValue({ numUpdatedRows: 1n }),
      };
      return query;
    }),
  };
  const service = new PageAuthorMigrationService(db as any);

  return { service, db, updateSets };
}

const page = {
  id: 'page-1',
  workspaceId: 'workspace-1',
  spaceId: 'space-1',
  creatorId: 'importer',
  lastUpdatedById: 'importer',
  sourceCreatorName: '旧创建者',
  sourceLastUpdatedByName: null,
};

const task = {
  id: 'task-1',
  workspaceId: 'workspace-1',
  spaceId: 'space-1',
  type: 'import',
  source: 'confluence',
  status: 'success',
};

describe('PageAuthorMigrationService', () => {
  it('真实用户更新 ID 并清空覆盖名，快照作者保留现有 ID', async () => {
    const { service, db, updateSets } = createSubject({
      pages: [page],
      fileTasks: [task],
      users: [
        {
          id: 'active-user',
          workspaceId: 'workspace-1',
          deletedAt: null,
        },
      ],
    });

    const result = await service.restorePageAuthors(
      [
        {
          pageId: 'page-1',
          importTaskId: 'task-1',
          creatorUserId: 'active-user',
          lastUpdatedByName: '  吴静  ',
        },
      ],
      'workspace-1',
    );

    expect(result.results).toEqual([
      { pageId: 'page-1', status: 'updated' },
    ]);
    expect(updateSets).toEqual([
      {
        creatorId: 'active-user',
        sourceCreatorName: null,
        sourceLastUpdatedByName: '吴静',
      },
    ]);
    expect(updateSets[0]).not.toHaveProperty('updatedAt');
    expect(updateSets[0]).not.toHaveProperty('content');
    expect(updateSets[0]).not.toHaveProperty(
      'contributorIds',
    );
    expect(db.selectFrom).toHaveBeenCalledTimes(3);
  });

  it('目标结果与页面一致时返回 unchanged', async () => {
    const { service, db } = createSubject({
      pages: [
        {
          ...page,
          creatorId: 'active-user',
          sourceCreatorName: null,
          sourceLastUpdatedByName: '吴静',
        },
      ],
      fileTasks: [task],
      users: [
        {
          id: 'active-user',
          workspaceId: 'workspace-1',
          deletedAt: null,
        },
      ],
    });

    const result = await service.restorePageAuthors(
      [
        {
          pageId: 'page-1',
          importTaskId: 'task-1',
          creatorUserId: 'active-user',
          lastUpdatedByName: '吴静',
        },
      ],
      'workspace-1',
    );

    expect(result.results[0]).toEqual({
      pageId: 'page-1',
      status: 'unchanged',
    });
    expect(db.updateTable).not.toHaveBeenCalled();
  });

  it('页面不存在时返回 skipped 并继续其他项', async () => {
    const { service, db } = createSubject({
      pages: [page],
      fileTasks: [task],
    });

    const result = await service.restorePageAuthors(
      [
        {
          pageId: 'missing-page',
          importTaskId: 'task-1',
          creatorName: '不存在',
        },
        {
          pageId: 'page-1',
          importTaskId: 'task-1',
          creatorName: '吴静',
        },
      ],
      'workspace-1',
    );

    expect(result.results).toEqual([
      {
        pageId: 'missing-page',
        status: 'skipped',
        reason: 'page_not_found',
      },
      { pageId: 'page-1', status: 'updated' },
    ]);
    expect(db.updateTable).toHaveBeenCalledTimes(1);
  });

  it.each([
    { fileTasks: [{ ...task, workspaceId: 'other-workspace' }] },
    { fileTasks: [{ ...task, spaceId: 'other-space' }] },
    { fileTasks: [{ ...task, source: 'notion' }] },
    { fileTasks: [{ ...task, status: 'failed' }] },
    { fileTasks: [{ ...task, type: 'export' }] },
    { fileTasks: [] },
  ])('非法导入任务逐项返回 failed', async ({ fileTasks }) => {
    const { service, db } = createSubject({
      pages: [page],
      fileTasks,
    });

    const result = await service.restorePageAuthors(
      [
        {
          pageId: 'page-1',
          importTaskId: 'task-1',
          creatorName: '吴静',
        },
      ],
      'workspace-1',
    );

    expect(result.results[0]).toEqual({
      pageId: 'page-1',
      status: 'failed',
      error: 'invalid_import_task',
    });
    expect(db.updateTable).not.toHaveBeenCalled();
  });

  it('用户不属于当前工作区或已删除时逐项返回 failed', async () => {
    const { service, db } = createSubject({
      pages: [page],
      fileTasks: [task],
      users: [
        {
          id: 'active-user',
          workspaceId: 'other-workspace',
          deletedAt: null,
        },
      ],
    });

    const result = await service.restorePageAuthors(
      [
        {
          pageId: 'page-1',
          importTaskId: 'task-1',
          creatorUserId: 'active-user',
        },
      ],
      'workspace-1',
    );

    expect(result.results[0]).toEqual({
      pageId: 'page-1',
      status: 'failed',
      error: 'user_not_found',
    });
    expect(db.updateTable).not.toHaveBeenCalled();
  });

  it('拒绝同一角色同时指定 userId 和 name', async () => {
    const { service, db } = createSubject({
      pages: [page],
      fileTasks: [task],
      users: [
        {
          id: 'active-user',
          workspaceId: 'workspace-1',
          deletedAt: null,
        },
      ],
    });

    const result = await service.restorePageAuthors(
      [
        {
          pageId: 'page-1',
          importTaskId: 'task-1',
          creatorUserId: 'active-user',
          creatorName: '吴静',
        },
      ],
      'workspace-1',
    );

    expect(result.results[0]).toEqual({
      pageId: 'page-1',
      status: 'failed',
      error: 'invalid_creator',
    });
    expect(db.updateTable).not.toHaveBeenCalled();
  });
});
