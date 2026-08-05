import { UserRole } from '../../common/helpers/types/permission';
import { AuthenticationExtension } from './authentication.extension';

describe('AuthenticationExtension', () => {
  const createSubject = () => {
    const tokenService = {
      verifyJwt: jest.fn().mockResolvedValue({
        sub: 'user-1',
        workspaceId: 'workspace-1',
      }),
    };
    const userRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'user-1',
        role: UserRole.OWNER,
      }),
    };
    const pageRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'page-1',
        deletedAt: null,
      }),
    };

    return new AuthenticationExtension(
      tokenService as any,
      userRepo as any,
      pageRepo as any,
      {} as any,
      {} as any,
    );
  };

  const payload = (readOnly: boolean) => ({
    documentName: 'page.page-1',
    token: 'collaboration-token',
    requestParameters: new URLSearchParams({
      readOnly: String(readOnly),
    }),
    connectionConfig: {
      readOnly: false,
    },
  });

  it('forces a permitted user connection into read-only mode when requested', async () => {
    const extension = createSubject();
    const data = payload(true);

    await extension.onAuthenticate(data as any);

    expect(data.connectionConfig.readOnly).toBe(true);
  });

  it('leaves edit-mode connections writable for permitted users', async () => {
    const extension = createSubject();
    const data = payload(false);

    await extension.onAuthenticate(data as any);

    expect(data.connectionConfig.readOnly).toBe(false);
  });
});
