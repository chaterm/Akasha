type PersonalSpaceIdentity = {
  personalOwnerId: string | null;
};

type SpaceWithId = {
  id: string;
};

export function isPersonalSpace(space: PersonalSpaceIdentity): boolean {
  return Boolean(space.personalOwnerId);
}

export function isPersonalSpaceOwner(
  space: PersonalSpaceIdentity,
  userId: string | null | undefined,
): boolean {
  return Boolean(userId && space.personalOwnerId === userId);
}

export function findPersonalSpaceById<T extends SpaceWithId>(
  spaces: T[],
  personalSpaceId: string | null | undefined,
): T | undefined {
  if (!personalSpaceId) return undefined;
  return spaces.find((space) => space.id === personalSpaceId);
}
