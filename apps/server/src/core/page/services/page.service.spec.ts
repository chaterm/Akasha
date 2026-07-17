jest.mock('../../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { PageService } from './page.service';

describe('PageService', () => {
  it('正常更新页面时清除来源最后修改者并记录真实用户', async () => {
    const pageRepo = {
      updatePage: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn().mockResolvedValue({ id: 'page-1' }),
    };
    const generalQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const service = new PageService(
      pageRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      generalQueue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await service.update(
      {
        id: 'page-1',
        spaceId: 'space-1',
        workspaceId: 'workspace-1',
        contributorIds: [],
      } as any,
      { pageId: 'page-1', title: '新标题' },
      { id: 'editing-user' } as any,
    );

    expect(pageRepo.updatePage).toHaveBeenCalledWith(
      expect.objectContaining({
        lastUpdatedById: 'editing-user',
        sourceLastUpdatedByName: null,
      }),
      'page-1',
    );
  });
});
