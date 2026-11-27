import { withApiKeyAccess } from '../../../common/auth/api-key-access';
import { NotFoundException } from '@nestjs/common';
import { SpaceRole, UserRole } from '../../../common/helpers/types/permission';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../interfaces/space-ability.type';
import SpaceAbilityFactory, {
  getSpaceMetadataPermissions,
} from './space-ability.factory';

describe('space metadata permissions', () => {
  const defaultSpace = {
    personalOwnerId: 'owner',
    creatorId: 'original-creator',
    isDefaultPersonal: true,
  };
  const privateSpace = {
    personalOwnerId: 'owner',
    creatorId: 'owner',
    isDefaultPersonal: false,
  };
  const publicSpace = {
    personalOwnerId: null,
    creatorId: 'owner',
    isDefaultPersonal: false,
  };

  it.each([
    [
      'default owner',
      defaultSpace,
      'owner',
      UserRole.MEMBER,
      true,
      true,
      false,
    ],
    [
      'invited default admin',
      defaultSpace,
      'guest',
      UserRole.MEMBER,
      true,
      false,
      false,
    ],
    [
      'public space admin',
      publicSpace,
      'guest',
      UserRole.MEMBER,
      true,
      true,
      false,
    ],
    [
      'private creator',
      privateSpace,
      'owner',
      UserRole.MEMBER,
      true,
      true,
      false,
    ],
    [
      'other private space admin',
      privateSpace,
      'guest',
      UserRole.MEMBER,
      true,
      false,
      false,
    ],
    [
      'member with read or edit access',
      publicSpace,
      'guest',
      UserRole.MEMBER,
      false,
      false,
      false,
    ],
    [
      'workspace admin on default',
      defaultSpace,
      'guest',
      UserRole.ADMIN,
      true,
      true,
      true,
    ],
    [
      'workspace admin on private',
      privateSpace,
      'guest',
      UserRole.ADMIN,
      true,
      true,
      true,
    ],
    [
      'workspace owner on public',
      publicSpace,
      'guest',
      UserRole.OWNER,
      true,
      true,
      true,
    ],
  ] as const)(
    'applies the field policy for %s',
    (_label, space, id, role, manage, edit, slug) => {
      expect(getSpaceMetadataPermissions(space, { id, role }, manage)).toEqual({
        icon: edit,
        name: edit,
        description: edit,
        slug,
      });
    },
  );

  it('rejects icon changes by an invited default-space admin', async () => {
    const spaceRepo = {
      findById: jest
        .fn()
        .mockResolvedValue({ id: 'default-1', ...defaultSpace }),
    };
    const spaceMemberRepo = {
      getUserSpaceRoles: jest
        .fn()
        .mockResolvedValue([{ role: SpaceRole.ADMIN }]),
    };
    const factory = new SpaceAbilityFactory(
      spaceMemberRepo as any,
      spaceRepo as any,
    );
    const user = { role: UserRole.MEMBER, workspaceId: 'workspace-1' };

    await expect(
      factory.assertCanEditSpaceIcon(
        { ...user, id: 'guest' } as any,
        'default-1',
      ),
    ).rejects.toThrow('Forbidden');
    await expect(
      factory.assertCanEditSpaceIcon(
        { ...user, id: 'owner' } as any,
        'default-1',
      ),
    ).resolves.toBe('default-1');
  });
});

describe('SpaceAbilityFactory API key policy', () => {
  const member = {
    id: 'user-1',
    role: UserRole.MEMBER,
  } as any;

  it('preserves the real shared-space membership ability for an API key', async () => {
    const spaceMemberRepo = {
      getUserSpaceRoles: jest
        .fn()
        .mockResolvedValue([
          { userId: 'user-1', spaceId: 'shared-1', role: 'admin' },
        ]),
    };
    const factory = new SpaceAbilityFactory(spaceMemberRepo as any, {} as any);
    const user = withApiKeyAccess(member, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    const ability = await factory.createForUser(user, 'shared-1');

    expect(ability.can(SpaceCaslAction.Read, SpaceCaslSubject.Page)).toBe(true);
    expect(ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page)).toBe(true);
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
    const factory = new SpaceAbilityFactory(spaceMemberRepo as any, {} as any);
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

describe('SpaceAbilityFactory workspace administrator access', () => {
  it.each([UserRole.OWNER, UserRole.ADMIN])(
    'grants %s full space management without membership',
    async (role) => {
      const spaceMemberRepo = {
        getUserSpaceRoles: jest.fn().mockResolvedValue([]),
      };
      const spaceRepo = {
        findById: jest.fn().mockResolvedValue({ id: 'space-1' }),
      };
      const factory = new SpaceAbilityFactory(
        spaceMemberRepo as any,
        spaceRepo as any,
      );

      const ability = await factory.createForUser(
        { id: 'user-1', role, workspaceId: 'workspace-1' } as any,
        'space-1',
      );

      for (const subject of Object.values(SpaceCaslSubject)) {
        expect(ability.can(SpaceCaslAction.Manage, subject)).toBe(true);
      }
      expect(spaceRepo.findById).toHaveBeenCalledWith('space-1', 'workspace-1');
      expect(spaceMemberRepo.getUserSpaceRoles).not.toHaveBeenCalled();
    },
  );

  it.each([UserRole.OWNER, UserRole.ADMIN])(
    'denies %s access to missing spaces or spaces outside the workspace',
    async (role) => {
      const spaceRepo = { findById: jest.fn().mockResolvedValue(undefined) };
      const factory = new SpaceAbilityFactory({} as any, spaceRepo as any);

      await expect(
        factory.createForUser(
          { id: 'user-1', role, workspaceId: 'workspace-1' } as any,
          'other-space',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(spaceRepo.findById).toHaveBeenCalledWith(
        'other-space',
        'workspace-1',
      );
    },
  );

  it('keeps ordinary members subject to their space membership', async () => {
    const spaceMemberRepo = {
      getUserSpaceRoles: jest.fn().mockResolvedValue([]),
    };
    const factory = new SpaceAbilityFactory(spaceMemberRepo as any, {} as any);
    const user = { id: 'user-1', role: UserRole.MEMBER } as any;

    await expect(factory.createForUser(user, 'space-1')).rejects.toThrow(
      NotFoundException,
    );

    spaceMemberRepo.getUserSpaceRoles.mockResolvedValue([
      { userId: 'user-1', role: SpaceRole.READER },
    ]);
    const ability = await factory.createForUser(user, 'space-1');
    expect(ability.can(SpaceCaslAction.Read, SpaceCaslSubject.Settings)).toBe(
      true,
    );
    expect(ability.can(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)).toBe(
      false,
    );
    expect(ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page)).toBe(
      false,
    );
  });
});
