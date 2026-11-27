import { IWorkspace } from "@/features/workspace/types/workspace.types";

export interface IUser {
  id: string;
  name: string;
  email: string;
  emailVerifiedAt: Date;
  avatarUrl: string;
  timezone: string;
  settings: IUserSettings;
  invitedById: string;
  lastLoginAt: string;
  lastActiveAt: Date;
  locale: string;
  createdAt: Date;
  updatedAt: Date;
  role: string;
  workspaceId: string;
  deactivatedAt: Date;
  deletedAt: Date;
  fullPageWidth: boolean;
  editorToolbar: boolean;
  notificationPageUpdates: boolean;
  notificationPageUserMention: boolean;
  notificationCommentUserMention: boolean;
  notificationCommentCreated: boolean;
  notificationCommentResolved: boolean;
  generalKnowledge: boolean;
  hasGeneratedPassword?: boolean;
}

export interface ICurrentUser {
  user: IUser;
  workspace: IWorkspace;
  personalSpaceId: string | null;
  personalSpaceIds?: string[];
}

export interface IUserSettings {
  preferences: {
    fullPageWidth: boolean;
    editorToolbar: boolean;
    generalKnowledge: boolean;
  };
  notifications?: {
    "page.updated"?: boolean;
    "page.userMention"?: boolean;
    "comment.userMention"?: boolean;
    "comment.created"?: boolean;
    "comment.resolved"?: boolean;
  };
}
