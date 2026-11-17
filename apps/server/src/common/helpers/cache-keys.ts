export const CacheKey = {
  LICENSE_VALID: (workspaceId: string) => `license:valid:${workspaceId}`,
  SPACE_ROLES: (userId: string, spaceId: string) =>
    `perm:space-roles:${userId}:${spaceId}`,
  PAGE_CAN_EDIT: (userId: string, pageId: string) =>
    `perm:can-edit:${userId}:${pageId}`,
};

export const PERMISSION_CACHE_TTL_MS = 5_000;
