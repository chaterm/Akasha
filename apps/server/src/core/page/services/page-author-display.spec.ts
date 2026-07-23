import { resolvePageAuthorDisplay } from './page-author-display';

describe('resolvePageAuthorDisplay', () => {
  const creator = {
    id: 'importer',
    name: '导入用户',
    avatarUrl: 'creator-avatar',
  };
  const lastUpdatedBy = {
    id: 'editor',
    name: '编辑用户',
    avatarUrl: 'editor-avatar',
  };

  it('分别使用 Confluence 创建者和最后修改者名称覆盖展示', () => {
    expect(
      resolvePageAuthorDisplay({
        creator,
        lastUpdatedBy,
        sourceCreatorName: '吴静',
        sourceLastUpdatedByName: '张三',
      }),
    ).toMatchObject({
      creator: { id: 'importer', name: '吴静', avatarUrl: null },
      lastUpdatedBy: { id: 'editor', name: '张三', avatarUrl: null },
    });
  });

  it('忽略空白覆盖名并保留真实用户对象', () => {
    const page = {
      creator,
      lastUpdatedBy,
      sourceCreatorName: '   ',
      sourceLastUpdatedByName: null,
    };

    const resolved = resolvePageAuthorDisplay(page);

    expect(resolved.creator).toBe(creator);
    expect(resolved.lastUpdatedBy).toBe(lastUpdatedBy);
  });

  it('不修改输入页面和真实用户对象', () => {
    const page = {
      creator,
      lastUpdatedBy,
      sourceCreatorName: '  吴静  ',
      sourceLastUpdatedByName: null,
    };

    const resolved = resolvePageAuthorDisplay(page);

    expect(resolved).not.toBe(page);
    expect(resolved.creator).not.toBe(creator);
    expect(creator).toEqual({
      id: 'importer',
      name: '导入用户',
      avatarUrl: 'creator-avatar',
    });
  });
});
