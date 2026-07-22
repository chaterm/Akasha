import { withApiKeyAccess } from '../../../common/auth/api-key-access';
import { UserRole } from '../../../common/helpers/types/permission';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../interfaces/space-ability.type';
import SpaceAbilityFactory from './space-ability.factory';

describe('SpaceAbilityFactory API key policy', () => {
  const member = {
    id: 'user-1',
    role: UserRole.MEMBER,
  } as any;

  it('downgrades shared spaces to read-only for an ordinary API key', async () => {
    const spaceMemberRepo = {
      getUserSpaceRoles: jest
        .fn()
        .mockResolvedValue([
          { userId: 'user-1', spaceId: 'shared-1', role: 'admin' },
        ]),
    };
    const factory = new SpaceAbilityFactory(spaceMemberRepo as any);
    const user = withApiKeyAccess(member, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    const ability = await factory.createForUser(user, 'shared-1');

    expect(ability.can(SpaceCaslAction.Read, SpaceCaslSubject.Page)).toBe(true);
    expect(ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page)).toBe(
      false,
    );
    expect(spaceMemberRepo.getUserSpaceRoles).toHaveBeenCalledWith(
      'user-1',
      'shared-1',
    );
  });

  it('preserves the real membership ability in the personal space', async () => {
    const spaceMemberRepo = {
      getUserSpaceRoles: jest
        .fn()
        .mockResolvedValue([
          { userId: 'user-1', spaceId: 'personal-1', role: 'admin' },
        ]),
    };
    const factory = new SpaceAbilityFactory(spaceMemberRepo as any);
    const user = withApiKeyAccess(member, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    const ability = await factory.createForUser(user, 'personal-1');

    expect(ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page)).toBe(true);
    expect(spaceMemberRepo.getUserSpaceRoles).toHaveBeenCalledWith(
      'user-1',
      'personal-1',
    );
  });
});
