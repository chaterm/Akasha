type PagePermissionUserMember = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  type: 'user';
  role: string;
  createdAt: Date;
};

type PagePermissionGroupMember = {
  id: string;
  name: string;
  memberCount: number;
  isDefault: boolean;
  type: 'group';
  role: string;
  createdAt: Date;
};

export type PagePermissionMember =
  | PagePermissionUserMember
  | PagePermissionGroupMember;

export interface RestrictedAncestorRequirement {
  pageAccessId: string;
  restrictedPageId: string;
  depth: number;
  permissions: Array<{
    userId: string | null;
    groupId: string | null;
    role: string;
  }>;
}

export interface SourcePageRestrictedAncestorRequirements {
  sourcePageId: string;
  sourceSpaceId: string;
  restrictedAncestors: RestrictedAncestorRequirement[];
}
