import { Test, TestingModule } from '@nestjs/testing';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import { SpaceController } from './space.controller';
import { SpaceMemberService } from './services/space-member.service';
import { SpaceService } from './services/space.service';
import { SpaceRole, UserRole } from '../../common/helpers/types/permission';
import { SpacePaginationOptions } from './dto/space-pagination-options.dto';
import { emptyCursorPaginationResult } from '@akasha/db/pagination/cursor-pagination';

describe('SpaceController', () => {
  let controller: SpaceController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SpaceController],
      providers: [
        SpaceService,
        SpaceMemberService,
        SpaceMemberRepo,
        SpaceRepo,
        SpaceAbilityFactory,
        WorkspaceAbilityFactory,
      ].map((provide) => ({ provide, useValue: {} })),
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SpaceController>(SpaceController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

describe('SpaceController knowledge publish mode', () => {
  function createController() {
    const spaceService = { updateSpace: jest.fn().mockResolvedValue({}) };
    const ability = { cannot: jest.fn().mockReturnValue(true) };
    const spaceAbility = {
      createForUser: jest.fn().mockResolvedValue(ability),
    };
    const controller = Object.create(SpaceController.prototype) as any;
    controller.spaceService = spaceService;
    controller.spaceAbility = spaceAbility;
    return { controller, spaceService, spaceAbility };
  }
  const workspace = { id: 'workspace-1' } as any;

  it('lets a workspace admin change it without space settings permission', async () => {
    const { controller, spaceService } = createController();
    const dto = { spaceId: 'space-1', knowledgeIndexMode: 'original' };

    await controller.updateSpace(dto, { role: UserRole.ADMIN }, workspace);

    expect(spaceService.updateSpace).toHaveBeenCalledWith(dto, 'workspace-1');
  });

  it('rejects members, even space admins', async () => {
    const { controller, spaceService } = createController();

    await expect(
      controller.updateSpace(
        { spaceId: 'space-1', knowledgeIndexMode: 'original' },
        { role: UserRole.MEMBER },
        workspace,
      ),
    ).rejects.toThrow('Forbidden');
    expect(spaceService.updateSpace).not.toHaveBeenCalled();
  });

  it('still requires space settings permission for other fields', async () => {
    const { controller, spaceService } = createController();

    await expect(
      controller.updateSpace(
        { spaceId: 'space-1', knowledgeIndexMode: 'original', name: 'New' },
        { role: UserRole.ADMIN },
        workspace,
      ),
    ).rejects.toThrow('Forbidden');
    expect(spaceService.updateSpace).not.toHaveBeenCalled();
  });
});

describe('SpaceController metadata updates', () => {
  const workspace = { id: 'workspace-1' };
  const member = { id: 'owner', role: UserRole.MEMBER };

  it('returns field permissions and rejects a mixed update with a read-only field', async () => {
    const space = {
      id: 'space-1',
      personalOwnerId: member.id,
      creatorId: 'original-creator',
      isDefaultPersonal: true,
    };
    const controller = Object.create(SpaceController.prototype) as any;
    controller.spaceService = {
      getSpaceInfo: jest.fn().mockResolvedValue(space),
      updateSpace: jest.fn().mockResolvedValue(space),
    };
    controller.spaceRepo = { findById: jest.fn().mockResolvedValue(space) };
    controller.spaceAbility = {
      createForUser: jest
        .fn()
        .mockResolvedValue({ cannot: () => false, rules: [] }),
    };
    controller.spaceMemberRepo = {
      getUserSpaceRoles: jest
        .fn()
        .mockResolvedValue([{ role: SpaceRole.ADMIN }]),
    };

    const result = await controller.getSpaceInfo(
      { spaceId: space.id },
      member,
      workspace,
    );
    expect(result.metadataPermissions).toEqual({
      icon: true,
      name: true,
      slug: false,
      description: true,
    });
    await expect(
      controller.updateSpace(
        { spaceId: space.id, name: 'New name', slug: 'newslug' },
        member,
        workspace,
      ),
    ).rejects.toThrow('Forbidden');
    expect(controller.spaceService.updateSpace).not.toHaveBeenCalled();

    const dto = {
      spaceId: space.id,
      name: 'New name',
      description: 'New description',
    };
    await controller.updateSpace(dto, member, workspace);
    expect(controller.spaceService.updateSpace).toHaveBeenCalledWith(
      dto,
      workspace.id,
    );
  });
});

describe('SpaceController space creation', () => {
  const workspace = { id: 'workspace-1' } as any;

  function createController(canManageSpaces: boolean) {
    const spaceService = { createSpace: jest.fn().mockResolvedValue({}) };
    const workspaceAbility = {
      createForUser: jest.fn().mockReturnValue({
        can: jest.fn().mockReturnValue(canManageSpaces),
      }),
    };
    const controller = Object.create(SpaceController.prototype) as any;
    controller.spaceService = spaceService;
    controller.workspaceAbility = workspaceAbility;
    return { controller, spaceService };
  }

  it('allows workspace members to create personal spaces', async () => {
    const { controller, spaceService } = createController(false);
    const user = { id: 'user-1', role: UserRole.MEMBER } as any;
    const dto = { name: 'Notes', slug: 'notes', type: 'personal' };

    await controller.createSpace(dto, user, workspace);

    expect(spaceService.createSpace).toHaveBeenCalledWith(
      user,
      workspace.id,
      dto,
    );
  });

  it('requires workspace space-management permission to create public spaces', async () => {
    const { controller, spaceService } = createController(false);
    const user = { id: 'user-1', role: UserRole.MEMBER } as any;

    expect(() =>
      controller.createSpace(
        { name: 'Team', slug: 'team', type: 'public' },
        user,
        workspace,
      ),
    ).toThrow('Forbidden');
    expect(spaceService.createSpace).not.toHaveBeenCalled();
  });

  it('keeps the existing default creation type public for workspace admins', async () => {
    const { controller, spaceService } = createController(true);
    const user = { id: 'user-1', role: UserRole.ADMIN } as any;
    const dto = { name: 'Team', slug: 'team' };

    await controller.createSpace(dto, user, workspace);

    expect(spaceService.createSpace).toHaveBeenCalledWith(
      user,
      workspace.id,
      dto,
    );
  });
});

describe('SpaceController effective space access', () => {
  const createSubject = () => {
    const spaces = [{ id: 'space-1' }, { id: 'space-2' }];
    const meta = {
      limit: 20,
      hasNextPage: true,
      hasPrevPage: false,
      nextCursor: 'next-page',
      prevCursor: null,
      total: 2,
    };
    const spaceService = {
      getWorkspaceSpaces: jest.fn().mockResolvedValue({ items: spaces, meta }),
      getSpaceInfo: jest.fn().mockResolvedValue(spaces[0]),
    };
    const spaceMemberService = {
      getUserSpaces: jest.fn().mockResolvedValue({ items: [spaces[0]], meta }),
    };
    const spaceMemberRepo = {
      getUserRolesForSpaces: jest.fn().mockResolvedValue([
        { spaceId: 'space-1', role: SpaceRole.READER },
        { spaceId: 'space-1', role: SpaceRole.WRITER },
      ]),
      getUserSpaceRoles: jest
        .fn()
        .mockResolvedValue([{ userId: 'user-1', role: SpaceRole.READER }]),
    };
    const spaceAbility = {
      createForUser: jest.fn().mockResolvedValue({
        cannot: jest.fn().mockReturnValue(false),
        rules: [{ action: 'manage', subject: 'settings' }],
      }),
    };
    const agentAccessService = {
      getBoundSpaceIds: jest.fn().mockResolvedValue(['space-2']),
    };
    const controller = new SpaceController(
      spaceService as any,
      spaceMemberService as any,
      spaceMemberRepo as any,
      {} as any,
      spaceAbility as any,
      {} as any,
      agentAccessService as any,
    );
    return {
      controller,
      spaceService,
      spaceMemberService,
      spaceMemberRepo,
      meta,
    };
  };
  const workspace = { id: 'workspace-1' } as any;
  const user = (role: UserRole) =>
    ({ id: 'user-1', role, workspaceId: workspace.id }) as any;
  const pagination = (role?: SpaceRole) =>
    ({
      limit: 20,
      query: 'space',
      cursor: 'cursor',
      role,
    }) as SpacePaginationOptions;

  it.each([UserRole.OWNER, UserRole.ADMIN])(
    'lists every workspace space for %s even without membership',
    async (role) => {
      const {
        controller,
        spaceService,
        spaceMemberService,
        spaceMemberRepo,
        meta,
      } = createSubject();
      const options = pagination();

      const result = await controller.getWorkspaceSpaces(
        options,
        user(role),
        workspace,
      );

      expect(result).toEqual({
        items: ['space-1', 'space-2'].map((id) => ({
          id,
          membership: { userId: 'user-1', role: SpaceRole.ADMIN },
        })),
        meta,
      });
      expect(spaceService.getWorkspaceSpaces).toHaveBeenCalledWith(
        workspace.id,
        options,
        undefined,
      );
      expect(spaceMemberService.getUserSpaces).not.toHaveBeenCalled();
      expect(spaceMemberRepo.getUserRolesForSpaces).not.toHaveBeenCalled();
    },
  );

  it.each([UserRole.OWNER, UserRole.ADMIN])(
    'includes every space in the full-access filter for %s',
    async (role) => {
      const { controller, spaceService } = createSubject();
      const options = pagination(SpaceRole.ADMIN);
      const result = await controller.getWorkspaceSpaces(
        options,
        user(role),
        workspace,
      );
      expect(result.items).toHaveLength(2);
      expect(spaceService.getWorkspaceSpaces).toHaveBeenCalledWith(
        workspace.id,
        options,
        undefined,
      );
    },
  );

  it.each([SpaceRole.WRITER, SpaceRole.READER])(
    'excludes workspace administrators from the %s-only filter',
    async (role) => {
      const { controller, spaceService, spaceMemberService } = createSubject();
      const result = await controller.getWorkspaceSpaces(
        pagination(role),
        user(UserRole.ADMIN),
        workspace,
      );
      expect(result).toEqual(emptyCursorPaginationResult(20, 0));
      expect(spaceService.getWorkspaceSpaces).not.toHaveBeenCalled();
      expect(spaceMemberService.getUserSpaces).not.toHaveBeenCalled();
    },
  );

  it('keeps member visibility and role filters based on direct and group memberships', async () => {
    const { controller, spaceService, spaceMemberService } = createSubject();
    const options = pagination(SpaceRole.WRITER);
    const result = await controller.getWorkspaceSpaces(
      options,
      user(UserRole.MEMBER),
      workspace,
    );
    expect(result.items).toEqual([
      {
        id: 'space-1',
        membership: { userId: 'user-1', role: SpaceRole.WRITER },
      },
    ]);
    expect(spaceService.getWorkspaceSpaces).not.toHaveBeenCalled();
    expect(spaceMemberService.getUserSpaces).toHaveBeenCalledWith(
      'user-1',
      options,
      undefined,
    );
  });

  it.each([UserRole.ADMIN, UserRole.MEMBER])(
    'scopes favorite spaces to the signed-in %s',
    async (role) => {
      const { controller, spaceService, spaceMemberService } = createSubject();
      const options = { ...pagination(), type: 'favorites' } as const;
      await controller.getWorkspaceSpaces(options, user(role), workspace);
      const scoped = { ...options, favoriteUserId: 'user-1' };
      if (role === UserRole.ADMIN) {
        expect(spaceService.getWorkspaceSpaces).toHaveBeenCalledWith(
          workspace.id,
          scoped,
          undefined,
        );
      } else {
        expect(spaceMemberService.getUserSpaces).toHaveBeenCalledWith(
          'user-1',
          scoped,
          undefined,
        );
      }
    },
  );

  it('lets members filter accessible personal spaces by kind', async () => {
    const { controller, spaceService, spaceMemberService } = createSubject();
    const options = {
      ...pagination(SpaceRole.WRITER),
      type: 'personal',
      personalKind: 'created',
    } as const;

    await controller.getWorkspaceSpaces(options, user(UserRole.MEMBER), workspace);
    expect(spaceMemberService.getUserSpaces).toHaveBeenCalledWith(
      'user-1',
      options,
      undefined,
    );
    expect(spaceService.getWorkspaceSpaces).not.toHaveBeenCalled();
  });

  it('limits personal-space owner search to workspace administrators', async () => {
    const { controller, spaceService, spaceMemberService } = createSubject();
    const options = {
      ...pagination(),
      type: 'personal',
      personalKind: 'created',
      ownerQuery: 'jane@example.com',
    } as const;

    await expect(
      controller.getWorkspaceSpaces(options, user(UserRole.MEMBER), workspace),
    ).rejects.toThrow('Forbidden');
    expect(spaceMemberService.getUserSpaces).not.toHaveBeenCalled();

    await controller.getWorkspaceSpaces(
      options,
      user(UserRole.ADMIN),
      workspace,
    );
    expect(spaceService.getWorkspaceSpaces).toHaveBeenCalledWith(
      workspace.id,
      options,
      undefined,
    );
  });

  it.each([UserRole.OWNER, UserRole.ADMIN])(
    'reports %s effective role as admin despite a lower space membership',
    async (role) => {
      const { controller, spaceMemberRepo } = createSubject();
      const result = await controller.getSpaceInfo(
        { spaceId: 'space-1' },
        user(role),
        workspace,
      );
      expect(result.membership.role).toBe(SpaceRole.ADMIN);
      expect(result.membership.permissions).toEqual([
        { action: 'manage', subject: 'settings' },
      ]);
      expect(spaceMemberRepo.getUserSpaceRoles).not.toHaveBeenCalled();
    },
  );

  it('preserves bound-space limits for agent requests', async () => {
    const { controller, spaceService } = createSubject();
    spaceService.getWorkspaceSpaces.mockResolvedValue({
      items: [{ id: 'space-2' }],
      meta: {
        limit: 20,
        hasNextPage: false,
        hasPrevPage: false,
        nextCursor: null,
        prevCursor: null,
        total: 1,
      },
    });
    const result = await controller.getWorkspaceSpaces(
      pagination(),
      user(UserRole.ADMIN),
      workspace,
      {} as any,
    );
    expect(result.items.map((space) => space.id)).toEqual(['space-2']);
    expect(result.meta.total).toBe(1);
    expect(spaceService.getWorkspaceSpaces).toHaveBeenCalledWith(
      workspace.id,
      pagination(),
      ['space-2'],
    );
  });
});
