import { UserRole } from '../helpers/types/permission';
import {
  isOrdinaryApiKeySpaceReadOnly,
  withApiKeyAccess,
} from './api-key-access';

describe('API key access context', () => {
  const member = {
    id: 'user-1',
    role: UserRole.MEMBER,
  } as any;

  it('allows an ordinary API key to write only its personal space', () => {
    const user = withApiKeyAccess(member, {
      apiKeyId: 'key-1',
      personalSpaceId: 'personal-1',
    });

    expect(isOrdinaryApiKeySpaceReadOnly(user, 'personal-1')).toBe(false);
    expect(isOrdinaryApiKeySpaceReadOnly(user, 'shared-1')).toBe(true);
  });

  it('keeps every space read-only when no personal space is resolved', () => {
    const user = withApiKeyAccess(member, {
      apiKeyId: 'key-1',
      personalSpaceId: null,
    });

    expect(isOrdinaryApiKeySpaceReadOnly(user, 'shared-1')).toBe(true);
  });

  it('does not apply the ordinary-user restriction to sessions or admins', () => {
    const admin = withApiKeyAccess(
      { ...member, role: UserRole.ADMIN },
      { apiKeyId: 'key-1', personalSpaceId: 'personal-1' },
    );

    expect(isOrdinaryApiKeySpaceReadOnly(member, 'shared-1')).toBe(false);
    expect(isOrdinaryApiKeySpaceReadOnly(admin, 'shared-1')).toBe(false);
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
