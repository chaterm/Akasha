import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { UserRole } from '../../../common/helpers/types/permission';
import { SpaceAuthorizationService } from './space-authorization.service';

describe('SpaceAuthorizationService', () => {
  it('returns all requested spaces for a workspace owner', async () => {
    const spaceMemberRepo = {
      findUserSpaceRolesForSpaces: jest.fn(),
    };
    const service = new SpaceAuthorizationService(
      spaceMemberRepo as unknown as SpaceMemberRepo,
    );

    await expect(
      service.filterReadableSpaceIds({
        user: {
          id: 'owner-1',
          role: UserRole.OWNER,
          workspaceId: 'workspace-1',
        },
        spaceIds: ['space-1', 'space-2'],
      }),
    ).resolves.toEqual(['space-1', 'space-2']);

    expect(spaceMemberRepo.findUserSpaceRolesForSpaces).not.toHaveBeenCalled();
  });

  it('returns spaces where a normal user has any readable role', async () => {
    const spaceMemberRepo = {
      findUserSpaceRolesForSpaces: jest.fn().mockResolvedValue([
        { userId: 'user-1', spaceId: 'space-1', role: 'reader' },
        { userId: 'user-1', spaceId: 'space-2', role: 'writer' },
        { userId: 'user-1', spaceId: 'space-2', role: 'reader' },
      ]),
    };
    const service = new SpaceAuthorizationService(
      spaceMemberRepo as unknown as SpaceMemberRepo,
    );

    await expect(
      service.filterReadableSpaceIds({
        user: {
          id: 'user-1',
          role: UserRole.MEMBER,
          workspaceId: 'workspace-1',
        },
        spaceIds: ['space-1', 'space-2', 'space-3'],
      }),
    ).resolves.toEqual(['space-1', 'space-2']);

    expect(spaceMemberRepo.findUserSpaceRolesForSpaces).toHaveBeenCalledWith({
      userId: 'user-1',
      spaceIds: ['space-1', 'space-2', 'space-3'],
    });
  });
});
