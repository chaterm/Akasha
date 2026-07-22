import { HoidcService } from './hoidc.service';
import { UnauthorizedException } from '@nestjs/common';

describe('HoidcService pure helpers', () => {
  // 构造 service 时依赖全传 null（只测纯逻辑方法，不需要 DB/网络）
  const svc = new HoidcService(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );

  describe('buildLoginUrl', () => {
    it('builds login url correctly', () => {
      const result = svc.buildLoginUrl({
        loginPage: 'https://sso.example.com',
        platformId: 'my-platform',
        callbackUrl: 'https://app.example.com/api/sso/hoidc/abc/callback',
      });

      expect(result).toBe(
        'https://sso.example.com?platform_id=my-platform&redirect=' +
          encodeURIComponent(
            'https://app.example.com/api/sso/hoidc/abc/callback',
          ),
      );
    });

    it('encodes callback url with query params', () => {
      const callbackUrl =
        'https://app.example.com/api/sso/hoidc/abc/callback?redirect=%2Fdashboard';
      const result = svc.buildLoginUrl({
        loginPage: 'https://sso.example.com',
        platformId: 'pid123',
        callbackUrl,
      });

      expect(result).toContain('platform_id=pid123');
      expect(result).toContain('redirect=' + encodeURIComponent(callbackUrl));
    });
  });

  describe('parseUserInfo', () => {
    it('parses userinfo from response', () => {
      const resp = {
        data: {
          email: 'user@example.com',
          name: 'Test User',
          avatar: 'https://cdn.example.com/avatar.png',
        },
      };

      const result = svc.parseUserInfo(resp);

      expect(result.email).toBe('user@example.com');
      expect(result.name).toBe('Test User');
      expect(result.avatar).toBe('https://cdn.example.com/avatar.png');
    });

    it('returns null for missing name and avatar', () => {
      const resp = {
        data: {
          email: 'user@example.com',
        },
      };

      const result = svc.parseUserInfo(resp);

      expect(result.email).toBe('user@example.com');
      expect(result.name).toBeNull();
      expect(result.avatar).toBeNull();
    });

    it('throws UnauthorizedException when email is missing', () => {
      const resp = {
        data: {
          name: 'No Email User',
        },
      };

      expect(() => svc.parseUserInfo(resp)).toThrow(UnauthorizedException);
      expect(() => svc.parseUserInfo(resp)).toThrow(
        'SSO response missing email',
      );
    });

    it('throws UnauthorizedException when data is null', () => {
      expect(() => svc.parseUserInfo(null)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when resp is empty object', () => {
      expect(() => svc.parseUserInfo({})).toThrow(UnauthorizedException);
    });
  });
});

describe('HoidcService provisioning', () => {
  const workspaceId = 'workspace-1';
  const config = {
    ssoApi: 'https://sso.example.com',
    platformId: 'platform-1',
    workspaceId,
    allowSignup: true,
  };

  function createTrxReturning(user: any) {
    const trx = {
      insertInto: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      executeTakeFirst: jest.fn().mockResolvedValue(user),
    };
    const db = {
      transaction: jest.fn(() => ({
        execute: (callback: any) => callback(trx),
      })),
    };
    return { db, trx };
  }

  it('creates missing SSO users with workspace, personal space, and default group', async () => {
    const newUser = {
      id: 'user-1',
      email: 'new@example.com',
      name: 'New User',
      avatarUrl: 'https://cdn.example.com/new.png',
      workspaceId,
      role: 'member',
    };
    const { db, trx } = createTrxReturning(newUser);
    const userRepo = {
      findByEmail: jest.fn().mockResolvedValue(null),
    };
    const workspaceService = {
      addUserToWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    const spaceService = {
      ensurePersonalSpace: jest.fn().mockResolvedValue(undefined),
    };
    const groupUserRepo = {
      addUserToDefaultGroup: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new HoidcService(
      db as any,
      userRepo as any,
      null as any,
      spaceService as any,
      workspaceService as any,
      groupUserRepo as any,
    );

    const result = await svc.provisionSsoUser({
      config,
      info: {
        email: 'NEW@example.com',
        name: 'New User',
        avatar: 'https://cdn.example.com/new.png',
      },
      updateProfile: true,
    });

    expect(result).toBe(newUser);
    expect(trx.insertInto).toHaveBeenCalledWith('users');
    expect(trx.values).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@example.com',
        name: 'New User',
        avatarUrl: 'https://cdn.example.com/new.png',
        workspaceId,
      }),
    );
    expect(workspaceService.addUserToWorkspace).toHaveBeenCalledWith(
      'user-1',
      workspaceId,
      undefined,
      trx,
    );
    expect(groupUserRepo.addUserToDefaultGroup).toHaveBeenCalledWith(
      'user-1',
      workspaceId,
      trx,
    );
    expect(spaceService.ensurePersonalSpace).toHaveBeenCalledWith(
      newUser,
      workspaceId,
      trx,
    );
  });

  it('updates an existing SSO user profile without resetting its role', async () => {
    const existingUser = {
      id: 'user-2',
      email: 'existing@example.com',
      name: 'Old Name',
      avatarUrl: null,
      workspaceId,
      role: 'admin',
    };
    const updatedUser = {
      ...existingUser,
      name: 'New Name',
      avatarUrl: 'https://cdn.example.com/avatar.png',
    };
    const userRepo = {
      findByEmail: jest
        .fn()
        .mockResolvedValueOnce(existingUser)
        .mockResolvedValueOnce(updatedUser),
      updateUser: jest.fn().mockResolvedValue(undefined),
    };
    const workspaceService = {
      addUserToWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    const spaceService = {
      ensurePersonalSpace: jest.fn().mockResolvedValue(undefined),
    };
    const groupUserRepo = {
      addUserToDefaultGroup: jest.fn().mockResolvedValue(undefined),
    };

    const svc = new HoidcService(
      null as any,
      userRepo as any,
      null as any,
      spaceService as any,
      workspaceService as any,
      groupUserRepo as any,
    );

    const result = await svc.provisionSsoUser({
      config,
      info: {
        email: 'existing@example.com',
        name: 'New Name',
        avatar: 'https://cdn.example.com/avatar.png',
      },
      updateProfile: true,
    });

    expect(result).toBe(updatedUser);
    expect(result.role).toBe('admin');
    expect(userRepo.updateUser).toHaveBeenCalledWith(
      {
        name: 'New Name',
        avatarUrl: 'https://cdn.example.com/avatar.png',
      },
      'user-2',
      workspaceId,
    );
    expect(workspaceService.addUserToWorkspace).not.toHaveBeenCalled();
    expect(groupUserRepo.addUserToDefaultGroup).toHaveBeenCalledWith(
      'user-2',
      workspaceId,
    );
    expect(spaceService.ensurePersonalSpace).toHaveBeenCalledWith(
      updatedUser,
      workspaceId,
    );
  });

  it('creates a session token after provisioning during login', async () => {
    const user = {
      id: 'user-3',
      email: 'login@example.com',
      workspaceId,
    };
    const svc = new HoidcService(
      null as any,
      null as any,
      {
        createSessionAndToken: jest.fn().mockResolvedValue('token-1'),
      } as any,
      null as any,
      null as any,
      null as any,
    );
    jest.spyOn(svc, 'provisionSsoUser').mockResolvedValue(user as any);

    const token = await svc.loginUser({
      config,
      info: { email: 'login@example.com', name: null, avatar: null },
    });

    expect(token).toBe('token-1');
    expect(svc.provisionSsoUser).toHaveBeenCalledWith({
      config,
      info: { email: 'login@example.com', name: null, avatar: null },
      updateProfile: true,
    });
  });
});
