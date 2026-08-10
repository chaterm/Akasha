import { UserRole } from '../helpers/types/permission';
import { getApiKeyAccess, withApiKeyAccess } from './api-key-access';

describe('API key access context', () => {
  const member = {
    id: 'user-1',
    role: UserRole.MEMBER,
  } as any;

  it('preserves API key metadata for callers that need it', () => {
    const user = withApiKeyAccess(member, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    expect(getApiKeyAccess(user)).toEqual({
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });
  });

  it('does not serialize API key access metadata with the user', () => {
    const user = withApiKeyAccess(member, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    expect(JSON.stringify(user)).not.toContain('key-1');
    expect(JSON.stringify(user)).not.toContain('personal-1');
  });
});
