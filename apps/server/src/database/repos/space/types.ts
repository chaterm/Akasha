export interface UserSpaceRole {
  userId: string;
  role: string;
}

export interface UserSpaceRoleWithSpaceId extends UserSpaceRole {
  spaceId: string;
}

interface SpaceUserInfo {
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
  type: 'user';
}

interface SpaceGroupInfo {
  id: string;
  name: string;
  isDefault: boolean;
  memberCount: number;
  type: 'group';
}

export type MemberInfo = SpaceUserInfo | SpaceGroupInfo;
