import type { User } from '@akasha/db/types/entity.types';
import { UserRole } from '../helpers/types/permission';

const API_KEY_ACCESS = Symbol('apiKeyAccess');

export type ApiKeyAccess = {
  apiKeyId: string;
  personalSpaceId: string | null;
};

type ApiKeyAuthenticatedUser = User & {
  [API_KEY_ACCESS]?: ApiKeyAccess;
};

export function withApiKeyAccess(
  user: User,
  access: ApiKeyAccess,
): ApiKeyAuthenticatedUser {
  const authenticatedUser = { ...user } as ApiKeyAuthenticatedUser;
  Object.defineProperty(authenticatedUser, API_KEY_ACCESS, {
    value: access,
    enumerable: false,
    writable: false,
  });
  return authenticatedUser;
}

export function getApiKeyAccess(user: User): ApiKeyAccess | undefined {
  return (user as ApiKeyAuthenticatedUser)[API_KEY_ACCESS];
}

export function isOrdinaryApiKeySpaceReadOnly(
  user: User,
  spaceId: string,
): boolean {
  const access = getApiKeyAccess(user);
  return Boolean(
    access &&
    user.role === UserRole.MEMBER &&
    access.personalSpaceId !== spaceId,
  );
}
