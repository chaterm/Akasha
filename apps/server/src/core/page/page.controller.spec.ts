jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { ForbiddenException } from '@nestjs/common';
import { PageController } from './page.controller';

describe('PageController', () => {
  const createSubject = (cannotManage: string[] = []) => {
    const pageRepo = {
      findSpaceIdsForPages: jest
        .fn()
        .mockResolvedValue(['space-1', 'space-2']),
    };
    const spaceAbility = {
      createForUser: jest.fn(async (_user, spaceId) => ({
        cannot: jest.fn().mockReturnValue(cannotManage.includes(spaceId)),
      })),
    };
    const migrationService = {
      restorePageAuthors: jest.fn().mockResolvedValue({
        results: [{ pageId: 'page-1', status: 'updated' }],
      }),
    };
    const controller = new PageController(
      {} as any,
      pageRepo as any,
      {} as any,
      {} as any,
      spaceAbility as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      migrationService as any,
    );

    return { controller, pageRepo, spaceAbility, migrationService };
  };

  const dto = {
    items: [
      {
        pageId: 'page-1',
        importTaskId: 'task-1',
        creatorName: '吴静',
      },
    ],
  };

  it('具备所有目标空间管理权限时调用作者修正服务', async () => {
    const { controller, pageRepo, spaceAbility, migrationService } =
      createSubject();

    const result = await controller.restoreAuthors(
      dto as any,
      { id: 'user-1' } as any,
      { id: 'workspace-1' } as any,
    );

    expect(pageRepo.findSpaceIdsForPages).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      pageIds: ['page-1'],
    });
    expect(spaceAbility.createForUser).toHaveBeenCalledTimes(2);
    expect(migrationService.restorePageAuthors).toHaveBeenCalledWith(
      dto.items,
      'workspace-1',
    );
    expect(result.results[0].status).toBe('updated');
  });

  it('任一目标空间没有管理权限时拒绝整个请求', async () => {
    const { controller, migrationService } = createSubject(['space-2']);

    await expect(
      controller.restoreAuthors(
        dto as any,
        { id: 'user-1' } as any,
        { id: 'workspace-1' } as any,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(migrationService.restorePageAuthors).not.toHaveBeenCalled();
  });
});
