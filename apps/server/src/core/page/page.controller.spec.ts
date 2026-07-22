jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { ForbiddenException } from '@nestjs/common';
import { withApiKeyAccess } from '../../common/auth/api-key-access';
import { UserRole } from '../../common/helpers/types/permission';
import { PageController } from './page.controller';

describe('PageController', () => {
  const createSubject = (cannotManage: string[] = []) => {
    const pageRepo = {
      findSpaceIdsForPages: jest.fn().mockResolvedValue(['space-1', 'space-2']),
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

  describe('personal Page source access for API keys', () => {
    const apiUser = withApiKeyAccess(
      { id: 'user-1', role: UserRole.MEMBER } as any,
      { apiKeyId: 'key-1', personalSpaceId: 'personal-1' },
    );
    const workspace = { id: 'workspace-1' } as any;

    const createPageSubject = () => {
      const pageRepo = {
        findById: jest.fn().mockResolvedValue({
          id: 'page-1',
          title: '雷雨',
          content: null,
          textContent: '雷声越过屋檐',
          spaceId: 'personal-1',
          updatedAt: new Date('2026-07-22T00:00:00.000Z'),
        }),
        searchPagesInSpace: jest.fn().mockResolvedValue([
          {
            id: 'page-1',
            title: '雷雨',
            textContent: '长风吹过城市，雷声越过屋檐，雨点落下。',
            updatedAt: new Date('2026-07-22T00:00:00.000Z'),
          },
        ]),
      };
      const pageAccessService = {
        validateCanReadSourceWithPermissions: jest.fn().mockResolvedValue({
          canEdit: true,
          hasRestriction: false,
        }),
        validateCanViewWithPermissions: jest.fn(),
      };
      const controller = new PageController(
        {} as any,
        pageRepo as any,
        {} as any,
        {} as any,
        {} as any,
        pageAccessService as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );

      return { controller, pageRepo, pageAccessService };
    };

    it('uses the source-read policy for page info', async () => {
      const { controller, pageAccessService } = createPageSubject();

      const result = await controller.getPage(
        { pageId: 'page-1' } as any,
        apiUser,
      );

      expect(
        pageAccessService.validateCanReadSourceWithPermissions,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'page-1' }),
        apiUser,
      );
      expect(
        pageAccessService.validateCanViewWithPermissions,
      ).not.toHaveBeenCalled();
      expect(result.permissions.canEdit).toBe(true);
    });

    it('searches only the personal space resolved from the API key', async () => {
      const { controller, pageRepo } = createPageSubject();

      const result = await controller.searchPersonalPages(
        { query: '雷雨', limit: 5 } as any,
        apiUser,
        workspace,
      );

      expect(pageRepo.searchPagesInSpace).toHaveBeenCalledWith({
        workspaceId: 'workspace-1',
        spaceId: 'personal-1',
        query: '雷雨',
        limit: 5,
      });
      expect(result.items).toEqual([
        expect.objectContaining({
          pageId: 'page-1',
          title: '雷雨',
          excerpt: expect.stringContaining('雷声'),
        }),
      ]);
    });

    it('rejects personal search when the API key has no personal space', async () => {
      const { controller, pageRepo } = createPageSubject();
      const userWithoutPersonalSpace = withApiKeyAccess(
        { id: 'user-1', role: UserRole.MEMBER } as any,
        { apiKeyId: 'key-1', personalSpaceId: null },
      );

      await expect(
        controller.searchPersonalPages(
          { query: '雷雨', limit: 5 } as any,
          userWithoutPersonalSpace,
          workspace,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(pageRepo.searchPagesInSpace).not.toHaveBeenCalled();
    });
  });
});
