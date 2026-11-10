import { IAuthProvider } from "@/ee/security/types/security.types.ts";

export interface IWorkspace {
  id: string;
  name: string;
  description: string;
  logo: string;
  hostname: string;
  defaultSpaceId: string;
  customDomain: string;
  enableInvite: boolean;
  settings: IWorkspaceSettings;
  status: string;
  enforceSso: boolean;
  stripeCustomerId: string;
  billingEmail: string;
  trialEndAt: Date;
  createdAt: Date;
  updatedAt: Date;
  emailDomains: string[];
  memberCount?: number;
  plan?: string;
  enforceMfa?: boolean;
  aiSearch?: boolean;
  generativeAi?: boolean;
  disablePublicSharing?: boolean;
  mcpEnabled?: boolean;
  trashRetentionDays?: number;
  restrictApiToAdmins?: boolean;
  allowMemberTemplates?: boolean;
  isScimEnabled?: boolean;
}

export interface IWorkspaceSettings {
  ai?: IWorkspaceAiSettings;
  sharing?: IWorkspaceSharingSettings;
  api?: IWorkspaceApiSettings;
  templates?: IWorkspaceTemplateSettings;
}

export interface IWorkspaceApiSettings {
  restrictToAdmins?: boolean;
}

export interface IWorkspaceAiSettings {
  search?: boolean;
  generative?: boolean;
  mcp?: boolean;
  chat?: boolean;
  skill?: IWorkspaceSkillSettings;
}

export interface IWorkspaceSkillSettings {
  latestVersion: string;
  upgradeUrl: string;
}

export interface IWorkspaceCompileWindowSettings {
  enabled: boolean;
  /** HH:mm, inclusive */
  startTime: string;
  /** HH:mm, exclusive; earlier than startTime crosses midnight */
  endTime: string;
  /** Read-only: the server timezone the window follows */
  serverTimezone?: string;
}

export interface IWorkspaceSharingSettings {
  disabled?: boolean;
}

export interface IWorkspaceTemplateSettings {
  allowMemberTemplates?: boolean;
}

export interface ICreateInvite {
  role: string;
  emails: string[];
  groupIds: string[];
}

export interface IInvitation {
  id: string;
  role: string;
  email: string;
  workspaceId: string;
  invitedById: string;
  createdAt: Date;
  enforceSso: boolean;
}

export interface IWorkspaceMemberGroup {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isExternal: boolean;
}

export interface IWorkspaceMemberDetail {
  user: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: string;
    locale: string | null;
    timezone: string | null;
    lastLoginAt: string | null;
    createdAt: string;
    deactivatedAt: string | null;
  };
  groups: IWorkspaceMemberGroup[];
}

export interface IInvitationLink {
  inviteLink: string;
}

export interface IAcceptInvite {
  invitationId: string;
  name: string;
  password: string;
  token: string;
}

export interface IPublicWorkspace {
  id: string;
  name: string;
  logo: string;
  hostname: string;
  enforceSso: boolean;
  authProviders: IAuthProvider[];
}

export interface IVersion {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}
