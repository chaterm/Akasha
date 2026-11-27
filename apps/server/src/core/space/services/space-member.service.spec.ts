import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SpaceRole } from '../../../common/helpers/types/permission';
import { SpaceMemberService } from './space-member.service';

describe('SpaceMemberService personal space owner protection', () => {
  const workspaceId = 'workspace-1';
  const personalOwnerId = 'user-1';

  function createService() {
    const service = Object.create(SpaceMemberService.prototype) as any;
    service.spaceRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'personal-1',
        name: 'Personal',
        personalOwnerId,
      }),
    };
    service.spaceMemberRepo = {
      getSpaceMemberByTypeId: jest.fn().mockResolvedValue({
        id: 'membership-1',
        userId: personalOwnerId,
        role: SpaceRole.ADMIN,
      }),
      updateSpaceMember: jest.fn(),
      removeSpaceMemberById: jest.fn(),
    };
    return service;
  }

  it.each([{ userIds: ['user-2'] }, { groupIds: ['group-1'] }])(
    'rejects adding members to a self-created personal space: %j',
    async (invitees) => {
      const service = createService();
      service.spaceRepo.findById.mockResolvedValue({
        personalOwnerId,
        isDefaultPersonal: false,
      });

      await expect(
        service.addMembersToSpaceBatch(
          { ...invitees, spaceId: 'personal-1', role: SpaceRole.READER },
          { id: personalOwnerId },
          workspaceId,
        ),
      ).rejects.toThrow(ForbiddenException);
    },
  );

  it('rejects removing the owner from a personal space', async () => {
    const service = createService();

    await expect(
      service.removeMemberFromSpace(
        { spaceId: 'personal-1', userId: personalOwnerId },
        workspaceId,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(
      service.spaceMemberRepo.removeSpaceMemberById,
    ).not.toHaveBeenCalled();
  });

  it('rejects demoting the owner of a personal space', async () => {
    const service = createService();

    await expect(
      service.updateSpaceMemberRole(
        {
          spaceId: 'personal-1',
          userId: personalOwnerId,
          role: SpaceRole.WRITER,
        },
        workspaceId,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(service.spaceMemberRepo.updateSpaceMember).not.toHaveBeenCalled();
  });
});
