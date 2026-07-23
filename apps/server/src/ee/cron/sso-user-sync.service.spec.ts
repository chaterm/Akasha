import { request } from 'undici';
import { SsoUserSyncService } from './sso-user-sync.service';

jest.mock('undici', () => ({
  request: jest.fn(),
}));

describe('SsoUserSyncService', () => {
  const env = {
    getSsoUserListApiUrl: jest.fn(() => 'https://webapi-sso.example.com'),
    getSsoUserListPlatformId: jest.fn(() => 'platform-1'),
    getSsoUserListSecret: jest.fn(() => 'secret-1'),
    isHoidcAllowSignup: jest.fn(() => true),
  };
  const workspaceRepo = {
    findFirst: jest.fn(() => Promise.resolve({ id: 'workspace-1' })),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches SSO users and provisions each user with profile updates', async () => {
    const hoidcService = {
      provisionSsoUser: jest.fn().mockResolvedValue({ id: 'user-1' }),
    };
    (request as jest.Mock).mockResolvedValue({
      statusCode: 200,
      body: {
        json: jest.fn().mockResolvedValue({
          code: 0,
          msg: '请求成功',
          data: [
            {
              email: 'first@example.com',
              name: 'First User',
              avatar: 'https://cdn.example.com/first.png',
            },
            {
              email: 'missing-avatar@example.com',
              name: 'Missing Avatar',
            },
            {
              name: 'Missing Email',
            },
          ],
        }),
      },
    });

    const service = new SsoUserSyncService(
      env as any,
      hoidcService as any,
      workspaceRepo as any,
    );

    const result = await service.syncAllUsers();

    expect(request).toHaveBeenCalledWith(
      expect.stringMatching(
        /^https:\/\/webapi-sso\.example\.com\/open-api\/user\/get-all\?signature=[a-f0-9]{32}&timestamp=\d+&platform_id=platform-1$/,
      ),
      { method: 'POST', body: '' },
    );
    expect(hoidcService.provisionSsoUser).toHaveBeenCalledTimes(2);
    expect(workspaceRepo.findFirst).toHaveBeenCalledTimes(1);
    expect(hoidcService.provisionSsoUser).toHaveBeenNthCalledWith(1, {
      config: {
        ssoApi: 'https://webapi-sso.example.com',
        platformId: 'platform-1',
        workspaceId: 'workspace-1',
        allowSignup: true,
      },
      info: {
        email: 'first@example.com',
        name: 'First User',
        avatar: 'https://cdn.example.com/first.png',
      },
      updateProfile: true,
    });
    expect(hoidcService.provisionSsoUser).toHaveBeenNthCalledWith(2, {
      config: {
        ssoApi: 'https://webapi-sso.example.com',
        platformId: 'platform-1',
        workspaceId: 'workspace-1',
        allowSignup: true,
      },
      info: {
        email: 'missing-avatar@example.com',
        name: 'Missing Avatar',
        avatar: null,
      },
      updateProfile: true,
    });
    expect(result).toEqual({
      fetched: 3,
      synced: 2,
      skipped: 1,
      failed: 0,
    });
  });

  it('continues syncing when one user fails', async () => {
    const hoidcService = {
      provisionSsoUser: jest
        .fn()
        .mockRejectedValueOnce(new Error('insert failed'))
        .mockResolvedValueOnce({ id: 'user-2' }),
    };
    (request as jest.Mock).mockResolvedValue({
      statusCode: 200,
      body: {
        json: jest.fn().mockResolvedValue({
          code: 0,
          data: [
            { email: 'fail@example.com', name: 'Fail User' },
            { email: 'ok@example.com', name: 'Ok User' },
          ],
        }),
      },
    });

    const service = new SsoUserSyncService(
      env as any,
      hoidcService as any,
      workspaceRepo as any,
    );

    const result = await service.syncAllUsers();

    expect(result).toEqual({
      fetched: 2,
      synced: 1,
      skipped: 0,
      failed: 1,
    });
  });

  it('skips sync when personnel list config is incomplete', async () => {
    const disabledEnv = {
      ...env,
      getSsoUserListSecret: jest.fn(() => ''),
    };
    const hoidcService = {
      provisionSsoUser: jest.fn(),
    };

    const service = new SsoUserSyncService(
      disabledEnv as any,
      hoidcService as any,
      workspaceRepo as any,
    );

    const result = await service.syncAllUsers();

    expect(request).not.toHaveBeenCalled();
    expect(hoidcService.provisionSsoUser).not.toHaveBeenCalled();
    expect(result).toEqual({
      fetched: 0,
      synced: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('skips sync when the database has no workspace', async () => {
    const hoidcService = {
      provisionSsoUser: jest.fn(),
    };
    const emptyWorkspaceRepo = {
      findFirst: jest.fn().mockResolvedValue(undefined),
    };
    const service = new SsoUserSyncService(
      env as any,
      hoidcService as any,
      emptyWorkspaceRepo as any,
    );

    const result = await service.syncAllUsers();

    expect(request).not.toHaveBeenCalled();
    expect(hoidcService.provisionSsoUser).not.toHaveBeenCalled();
    expect(result).toEqual({
      fetched: 0,
      synced: 0,
      skipped: 0,
      failed: 0,
    });
  });
});
