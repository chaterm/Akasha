import { ForbiddenException } from '@nestjs/common';
import { User } from '@akasha/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import { SsoUserSyncController } from './sso-user-sync.controller';

describe('SsoUserSyncController', () => {
  const syncResult = {
    fetched: 3,
    synced: 2,
    skipped: 1,
    failed: 0,
  };

  it('runs the SSO user sync for an owner', async () => {
    const ssoUserSyncService = {
      syncAllUsers: jest.fn().mockResolvedValue(syncResult),
    };
    const controller = new SsoUserSyncController(ssoUserSyncService as any);

    await expect(controller.sync(ownerUser())).resolves.toEqual(syncResult);
    expect(ssoUserSyncService.syncAllUsers).toHaveBeenCalledTimes(1);
  });

  it.each([UserRole.ADMIN, UserRole.MEMBER])(
    'rejects the %s role',
    async (role) => {
      const ssoUserSyncService = {
        syncAllUsers: jest.fn(),
      };
      const controller = new SsoUserSyncController(ssoUserSyncService as any);

      await expect(controller.sync(userWithRole(role))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(ssoUserSyncService.syncAllUsers).not.toHaveBeenCalled();
    },
  );
});

function ownerUser(): User {
  return userWithRole(UserRole.OWNER);
}

function userWithRole(role: UserRole): User {
  return { role } as User;
}
