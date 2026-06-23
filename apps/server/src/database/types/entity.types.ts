import { Insertable, Selectable, Updateable } from 'kysely';
import {
  AiChats,
  AiChatMessages,
  Attachments,
  Comments,
  Groups,
  Labels,
  Notifications,
  PageLabels,
  PageAccess as _PageAccess,
  PageTransclusions,
  PageTransclusionReferences,
  PagePermissions as _PagePermissions,
  PageVerifications as _PageVerifications,
  PageVerifiers as _PageVerifiers,
  Pages,
  Spaces,
  Users,
  Workspaces,
  PageHistory as History,
  GroupUsers,
  SpaceMembers,
  WorkspaceInvitations,
  UserTokens,
  Backlinks,
  Billing as BillingSubscription,
  AuthProviders,
  AuthAccounts,
  Shares,
  Favorites,
  FileTasks,
  KnowledgeChunks,
  KnowledgeChunkSources,
  KnowledgeClaims,
  KnowledgeClaimSources,
  KnowledgeGraphEdges,
  KnowledgeGraphEdgeSources,
  KnowledgeLinks,
  KnowledgeLinkSources,
  KnowledgePages,
  KnowledgePageSources,
  KnowledgeQueryAudit,
  KnowledgeReviewApplications,
  KnowledgeReviewSnapshots,
  KnowledgeQuarantinedArtifacts,
  KnowledgeSourceAccessPolicy as _KnowledgeSourceAccessPolicy,
  KnowledgeSourceAccessPrincipals as _KnowledgeSourceAccessPrincipals,
  KnowledgeSourceAccessRequirements as _KnowledgeSourceAccessRequirements,
  KnowledgeSourceChunks,
  KnowledgeSources,
  UserMfa as _UserMFA,
  UserSessions,
  ApiKeys,
  ScimTokens,
  Watchers,
  Audit as _Audit,
  Templates,
} from './db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';

// AI Chat
export type AiChat = Selectable<AiChats>;
export type InsertableAiChat = Insertable<AiChats>;
export type UpdatableAiChat = Updateable<Omit<AiChats, 'id'>>;

// AI Chat Message
// `tsv` is an internal tsvector column maintained by a trigger for
// full-text search. It is omitted from the public type so it never leaks
// into HTTP responses or the chat history fed to the language model.
export type AiChatMessage = Omit<Selectable<AiChatMessages>, 'tsv'>;
export type InsertableAiChatMessage = Omit<Insertable<AiChatMessages>, 'tsv'>;

// LLM Wiki Knowledge Base
export type KnowledgeSource = Selectable<KnowledgeSources>;
export type InsertableKnowledgeSource = Insertable<KnowledgeSources>;
export type UpdatableKnowledgeSource = Updateable<Omit<KnowledgeSources, 'id'>>;

export type KnowledgeSourceChunk = Selectable<KnowledgeSourceChunks>;
export type InsertableKnowledgeSourceChunk = Insertable<KnowledgeSourceChunks>;
export type UpdatableKnowledgeSourceChunk = Updateable<
  Omit<KnowledgeSourceChunks, 'id'>
>;

export type KnowledgePage = Selectable<KnowledgePages>;
export type InsertableKnowledgePage = Insertable<KnowledgePages>;
export type UpdatableKnowledgePage = Updateable<Omit<KnowledgePages, 'id'>>;

export type KnowledgePageSource = Selectable<KnowledgePageSources>;
export type InsertableKnowledgePageSource = Insertable<KnowledgePageSources>;

export type KnowledgeClaim = Selectable<KnowledgeClaims>;
export type InsertableKnowledgeClaim = Insertable<KnowledgeClaims>;
export type UpdatableKnowledgeClaim = Updateable<Omit<KnowledgeClaims, 'id'>>;

export type KnowledgeClaimSource = Selectable<KnowledgeClaimSources>;
export type InsertableKnowledgeClaimSource = Insertable<KnowledgeClaimSources>;

export type KnowledgeChunk = Selectable<KnowledgeChunks>;
export type InsertableKnowledgeChunk = Insertable<KnowledgeChunks>;
export type UpdatableKnowledgeChunk = Updateable<Omit<KnowledgeChunks, 'id'>>;

export type KnowledgeChunkSource = Selectable<KnowledgeChunkSources>;
export type InsertableKnowledgeChunkSource = Insertable<KnowledgeChunkSources>;

export type KnowledgeLink = Selectable<KnowledgeLinks>;
export type InsertableKnowledgeLink = Insertable<KnowledgeLinks>;
export type UpdatableKnowledgeLink = Updateable<Omit<KnowledgeLinks, 'id'>>;

export type KnowledgeLinkSource = Selectable<KnowledgeLinkSources>;
export type InsertableKnowledgeLinkSource = Insertable<KnowledgeLinkSources>;

export type KnowledgeGraphEdge = Selectable<KnowledgeGraphEdges>;
export type InsertableKnowledgeGraphEdge = Insertable<KnowledgeGraphEdges>;
export type UpdatableKnowledgeGraphEdge = Updateable<
  Omit<KnowledgeGraphEdges, 'id'>
>;

export type KnowledgeGraphEdgeSource = Selectable<KnowledgeGraphEdgeSources>;
export type InsertableKnowledgeGraphEdgeSource =
  Insertable<KnowledgeGraphEdgeSources>;

export type KnowledgeSourceAccessPolicy =
  Selectable<_KnowledgeSourceAccessPolicy>;
export type InsertableKnowledgeSourceAccessPolicy =
  Insertable<_KnowledgeSourceAccessPolicy>;
export type UpdatableKnowledgeSourceAccessPolicy =
  Updateable<_KnowledgeSourceAccessPolicy>;

export type KnowledgeSourceAccessRequirement =
  Selectable<_KnowledgeSourceAccessRequirements>;
export type InsertableKnowledgeSourceAccessRequirement =
  Insertable<_KnowledgeSourceAccessRequirements>;

export type KnowledgeSourceAccessPrincipal =
  Selectable<_KnowledgeSourceAccessPrincipals>;
export type InsertableKnowledgeSourceAccessPrincipal =
  Insertable<_KnowledgeSourceAccessPrincipals>;

export type KnowledgeQueryAuditEntry = Selectable<KnowledgeQueryAudit>;
export type InsertableKnowledgeQueryAuditEntry =
  Insertable<KnowledgeQueryAudit>;

export type KnowledgeReviewSnapshot = Selectable<KnowledgeReviewSnapshots>;
export type InsertableKnowledgeReviewSnapshot =
  Insertable<KnowledgeReviewSnapshots>;
export type UpdatableKnowledgeReviewSnapshot = Updateable<
  Omit<KnowledgeReviewSnapshots, 'id'>
>;

export type KnowledgeReviewApplication =
  Selectable<KnowledgeReviewApplications>;
export type InsertableKnowledgeReviewApplication =
  Insertable<KnowledgeReviewApplications>;
export type UpdatableKnowledgeReviewApplication = Updateable<
  Omit<KnowledgeReviewApplications, 'id'>
>;

export type KnowledgeQuarantinedArtifact =
  Selectable<KnowledgeQuarantinedArtifacts>;
export type InsertableKnowledgeQuarantinedArtifact =
  Insertable<KnowledgeQuarantinedArtifacts>;

// Workspace
export type Workspace = Selectable<Workspaces>;
export type InsertableWorkspace = Insertable<Workspaces>;
export type UpdatableWorkspace = Updateable<Omit<Workspaces, 'id'>>;

// WorkspaceInvitation
export type WorkspaceInvitation = Selectable<WorkspaceInvitations>;
export type InsertableWorkspaceInvitation = Insertable<WorkspaceInvitations>;
export type UpdatableWorkspaceInvitation = Updateable<
  Omit<WorkspaceInvitations, 'id'>
>;

// User
export type User = Selectable<Users>;
export type InsertableUser = Insertable<Users>;
export type UpdatableUser = Updateable<Omit<Users, 'id'>>;

// Space
export type Space = Selectable<Spaces>;
export type InsertableSpace = Insertable<Spaces>;
export type UpdatableSpace = Updateable<Omit<Spaces, 'id'>>;

// SpaceMember
export type SpaceMember = Selectable<SpaceMembers>;
export type InsertableSpaceMember = Insertable<SpaceMembers>;
export type UpdatableSpaceMember = Updateable<Omit<SpaceMembers, 'id'>>;

// Group
export type ExtendedGroup = Groups & { memberCount: number };

export type Group = Selectable<Groups>;
export type InsertableGroup = Insertable<Groups>;
export type UpdatableGroup = Updateable<Omit<Groups, 'id'>>;

// GroupUser
export type GroupUser = Selectable<GroupUsers>;
export type InsertableGroupUser = Insertable<GroupUsers>;
export type UpdatableGroupUser = Updateable<Omit<GroupUsers, 'id'>>;

// Page
export type Page = Selectable<Pages>;
export type InsertablePage = Insertable<Pages>;
export type UpdatablePage = Updateable<Omit<Pages, 'id'>>;

// PageHistory
export type PageHistory = Selectable<History>;
export type InsertablePageHistory = Insertable<History>;
export type UpdatablePageHistory = Updateable<Omit<History, 'id'>>;

// Comment
export type Comment = Selectable<Comments>;
export type InsertableComment = Insertable<Comments>;
export type UpdatableComment = Updateable<Omit<Comments, 'id'>>;

// Attachment
export type Attachment = Selectable<Attachments>;
export type InsertableAttachment = Insertable<Attachments>;
export type UpdatableAttachment = Updateable<Omit<Attachments, 'id'>>;

// User Token
export type UserToken = Selectable<UserTokens>;
export type InsertableUserToken = Insertable<UserTokens>;
export type UpdatableUserToken = Updateable<Omit<UserTokens, 'id'>>;

// Backlink
export type Backlink = Selectable<Backlinks>;
export type InsertableBacklink = Insertable<Backlink>;
export type UpdatableBacklink = Updateable<Omit<Backlink, 'id'>>;

// Billing
export type Billing = Selectable<BillingSubscription>;
export type InsertableBilling = Insertable<BillingSubscription>;
export type UpdatableBilling = Updateable<Omit<BillingSubscription, 'id'>>;

// Auth Provider
export type AuthProvider = Selectable<AuthProviders>;
export type InsertableAuthProvider = Insertable<AuthProviders>;
export type UpdatableAuthProvider = Updateable<Omit<AuthProviders, 'id'>>;

// Auth Account
export type AuthAccount = Selectable<AuthAccounts>;
export type InsertableAuthAccount = Insertable<AuthAccounts>;
export type UpdatableAuthAccount = Updateable<Omit<AuthAccounts, 'id'>>;

// Share
export type Share = Selectable<Shares>;
export type InsertableShare = Insertable<Shares>;
export type UpdatableShare = Updateable<Omit<Shares, 'id'>>;

// Favorite
export type Favorite = Selectable<Favorites>;
export type InsertableFavorite = Insertable<Favorites>;
export type UpdatableFavorite = Updateable<Omit<Favorites, 'id'>>;

// Page Transclusion
export type PageTransclusion = Selectable<PageTransclusions>;
export type InsertablePageTransclusion = Insertable<PageTransclusions>;
export type UpdatablePageTransclusion = Updateable<
  Omit<PageTransclusions, 'id'>
>;

// Page Transclusion Reference
export type PageTransclusionReference = Selectable<PageTransclusionReferences>;
export type InsertablePageTransclusionReference =
  Insertable<PageTransclusionReferences>;
export type UpdatablePageTransclusionReference = Updateable<
  Omit<PageTransclusionReferences, 'id'>
>;

// File Task
export type FileTask = Selectable<FileTasks>;
export type InsertableFileTask = Insertable<FileTasks>;
export type UpdatableFileTask = Updateable<Omit<FileTasks, 'id'>>;

// UserMFA
export type UserMFA = Selectable<_UserMFA>;
export type InsertableUserMFA = Insertable<_UserMFA>;
export type UpdatableUserMFA = Updateable<Omit<_UserMFA, 'id'>>;

// Api Keys
export type ApiKey = Selectable<ApiKeys>;
export type InsertableApiKey = Insertable<ApiKeys>;
export type UpdatableApiKey = Updateable<Omit<ApiKeys, 'id'>>;

// Scim Tokens
export type ScimToken = Selectable<ScimTokens>;
export type InsertableScimToken = Insertable<ScimTokens>;
export type UpdatableScimToken = Updateable<Omit<ScimTokens, 'id'>>;

// Page Embedding
export type PageEmbedding = Selectable<PageEmbeddings>;
export type InsertablePageEmbedding = Insertable<PageEmbeddings>;
export type UpdatablePageEmbedding = Updateable<Omit<PageEmbeddings, 'id'>>;

// Notification
export type Notification = Selectable<Notifications>;
export type InsertableNotification = Insertable<Notifications>;
export type UpdatableNotification = Updateable<Omit<Notifications, 'id'>>;

// Watcher
export type Watcher = Selectable<Watchers>;
export type InsertableWatcher = Insertable<Watchers>;
export type UpdatableWatcher = Updateable<Omit<Watchers, 'id'>>;

// Label
export type Label = Selectable<Labels>;
export type InsertableLabel = Insertable<Labels>;
export type UpdatableLabel = Updateable<Omit<Labels, 'id'>>;

// PageLabel
export type PageLabel = Selectable<PageLabels>;
export type InsertablePageLabel = Insertable<PageLabels>;

// Page Access
export type PageAccess = Selectable<_PageAccess>;
export type InsertablePageAccess = Insertable<_PageAccess>;
export type UpdatablePageAccess = Updateable<Omit<_PageAccess, 'id'>>;

// Page Permission
export type PagePermission = Selectable<_PagePermissions>;
export type InsertablePagePermission = Insertable<_PagePermissions>;
export type UpdatablePagePermission = Updateable<Omit<_PagePermissions, 'id'>>;

// Page Verification
export type PageVerification = Selectable<_PageVerifications>;
export type InsertablePageVerification = Insertable<_PageVerifications>;
export type UpdatablePageVerification = Updateable<
  Omit<_PageVerifications, 'id'>
>;

// Page Verifier
export type PageVerifier = Selectable<_PageVerifiers>;
export type InsertablePageVerifier = Insertable<_PageVerifiers>;

// User Session
export type UserSession = Selectable<UserSessions>;
export type InsertableUserSession = Insertable<UserSessions>;
export type UpdatableUserSession = Updateable<Omit<UserSessions, 'id'>>;

// Audit
export type Audit = Selectable<_Audit>;
export type InsertableAudit = Insertable<_Audit>;
export type UpdatableAudit = Updateable<Omit<_Audit, 'id'>>;

// Template
export type Template = Selectable<Templates>;
export type InsertableTemplate = Insertable<Templates>;
export type UpdatableTemplate = Updateable<Omit<Templates, 'id'>>;
