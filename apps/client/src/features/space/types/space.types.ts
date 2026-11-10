import { SpaceRole } from "@/lib/types.ts";
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from "@/features/space/permissions/permissions.type.ts";
import { ExportFormat } from "@/features/page/types/page.types.ts";
import type { KnowledgeSpaceIndexMode } from "@/features/page/services/page-service.ts";
import { QueryParams } from "@/lib/types.ts";

export type SpaceType = "public" | "personal";

export interface SpaceQueryParams extends QueryParams {
  type?: SpaceType;
}

export interface ISpaceSharingSettings {
  disabled?: boolean;
}

export interface ISpaceCommentsSettings {
  allowViewerComments?: boolean;
}

export interface ISpaceKnowledgeSettings {
  indexMode?: KnowledgeSpaceIndexMode;
}

export interface ISpaceSettings {
  sharing?: ISpaceSharingSettings;
  comments?: ISpaceCommentsSettings;
  knowledge?: ISpaceKnowledgeSettings;
}

export interface ISpace {
  id: string;
  name: string;
  description: string;
  logo?: string;
  slug: string;
  hostname: string;
  creatorId: string;
  personalOwnerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  memberCount?: number;
  spaceId?: string;
  membership?: IMembership;
  settings?: ISpaceSettings;
  // for updates
  disablePublicSharing?: boolean;
  allowViewerComments?: boolean;
  knowledgeIndexMode?: KnowledgeSpaceIndexMode;
}

interface IMembership {
  userId: string;
  role: SpaceRole;
  permissions?: Permissions;
}

interface Permission {
  action: SpaceCaslAction;
  subject: SpaceCaslSubject;
}

type Permissions = Permission[];

export interface IAddSpaceMember {
  spaceId: string;
  userIds?: string[];
  groupIds?: string[];
}

export interface IRemoveSpaceMember {
  spaceId: string;
  userId?: string;
  groupId?: string;
}

export interface IChangeSpaceMemberRole {
  spaceId: string;
  userId?: string;
  groupId?: string;
}

// space member
export interface SpaceUserInfo {
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
  type: "user";
}

export interface SpaceGroupInfo {
  id: string;
  name: string;
  isDefault: boolean;
  memberCount: number;
  type: "group";
}

export type ISpaceMember = { role: string } & (SpaceUserInfo | SpaceGroupInfo);

export interface IExportSpaceParams {
  spaceId: string;
  format: ExportFormat;
}
