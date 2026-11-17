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
  PageVisits,
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
  KnowledgeChunkAttachments,
  KnowledgeArtifactContributions,
  KnowledgeCompilationAttempts,
  KnowledgeChunkSources,
  KnowledgeImageExtractions,
  KnowledgeLinks,
  KnowledgeLinkSources,
  KnowledgePages,
  KnowledgePageSources,
  KnowledgePageIndexSettings,
  KnowledgeParentSections,
  KnowledgeParentSectionSources,
  KnowledgeEmbeddingRebuildBatches,
  KnowledgeQueryAudit,
  KnowledgeQuarantinedArtifacts,
  KnowledgeSourceAccessPolicy as _KnowledgeSourceAccessPolicy,
  KnowledgeSourceAccessPrincipals as _KnowledgeSourceAccessPrincipals,
  KnowledgeSourceAccessRequirements as _KnowledgeSourceAccessRequirements,
  KnowledgeSourceChunks,
  KnowledgeSourceAnalyses,
  KnowledgeSources,
  KnowledgeSpaceCompileRunPages,
  KnowledgeSpaceCompileRunImages,
  KnowledgeSpaceCompileRuns,
  UserMfa as _UserMFA,
  UserSessions,
  ApiKeys,
  ApiKeySpaces,
  AiModelConfigs,
  ScimTokens,
  Watchers,
  Audit as _Audit,
  Templates,
  JsonValue,
} from './db';
import { PageEmbeddings } from '@akasha/db/types/embeddings.types';

export type AiChat = Selectable<AiChats>;
export type InsertableAiChat = Insertable<AiChats>;
export type UpdatableAiChat = Updateable<Omit<AiChats, 'id'>>;

export type AiChatMessage = Omit<Selectable<AiChatMessages>, 'tsv'>;
export type InsertableAiChatMessage = Omit<Insertable<AiChatMessages>, 'tsv'>;

export type KnowledgeSource = Selectable<KnowledgeSources>;
export type InsertableKnowledgeSource = Insertable<KnowledgeSources>;
export type UpdatableKnowledgeSource = Updateable<Omit<KnowledgeSources, 'id'>>;

export type KnowledgeCompilationAttempt =
  Selectable<KnowledgeCompilationAttempts>;
export type InsertableKnowledgeCompilationAttempt =
  Insertable<KnowledgeCompilationAttempts>;
export type UpdatableKnowledgeCompilationAttempt = Updateable<
  Omit<KnowledgeCompilationAttempts, 'id'>
>;

export type KnowledgeSpaceCompileRun = Selectable<KnowledgeSpaceCompileRuns>;
export type InsertableKnowledgeSpaceCompileRun =
  Insertable<KnowledgeSpaceCompileRuns>;
export type UpdatableKnowledgeSpaceCompileRun = Updateable<
  Omit<KnowledgeSpaceCompileRuns, 'id'>
>;

export type KnowledgeSpaceCompileRunPage =
  Selectable<KnowledgeSpaceCompileRunPages>;
export type InsertableKnowledgeSpaceCompileRunPage =
  Insertable<KnowledgeSpaceCompileRunPages>;
export type UpdatableKnowledgeSpaceCompileRunPage = Updateable<
  Omit<KnowledgeSpaceCompileRunPages, 'id'>
>;

export type KnowledgeSpaceCompileRunImage =
  Selectable<KnowledgeSpaceCompileRunImages>;
export type InsertableKnowledgeSpaceCompileRunImage =
  Insertable<KnowledgeSpaceCompileRunImages>;
export type UpdatableKnowledgeSpaceCompileRunImage = Updateable<
  Omit<KnowledgeSpaceCompileRunImages, 'id'>
>;

export type KnowledgeSourceAnalysis = Selectable<KnowledgeSourceAnalyses>;
export type InsertableKnowledgeSourceAnalysis =
  Insertable<KnowledgeSourceAnalyses>;

export type KnowledgeImageExtraction = Selectable<KnowledgeImageExtractions>;
export type InsertableKnowledgeImageExtraction =
  Insertable<KnowledgeImageExtractions>;
export type UpdatableKnowledgeImageExtraction = Updateable<
  Omit<KnowledgeImageExtractions, 'id'>
>;

export type KnowledgeArtifactContribution =
  Selectable<KnowledgeArtifactContributions>;
export type InsertableKnowledgeArtifactContribution =
  Insertable<KnowledgeArtifactContributions>;

export type KnowledgeSourceChunk = Selectable<KnowledgeSourceChunks>;
export type InsertableKnowledgeSourceChunk = Insertable<KnowledgeSourceChunks>;
export type UpdatableKnowledgeSourceChunk = Updateable<
  Omit<KnowledgeSourceChunks, 'id'>
>;

export type KnowledgePage = Omit<Selectable<KnowledgePages>, 'generationMode'> &
  Partial<Pick<Selectable<KnowledgePages>, 'generationMode'>>;
export type InsertableKnowledgePage = Insertable<KnowledgePages>;
export type UpdatableKnowledgePage = Updateable<Omit<KnowledgePages, 'id'>>;

export type KnowledgePageIndexSetting = Selectable<KnowledgePageIndexSettings>;
export type InsertableKnowledgePageIndexSetting =
  Insertable<KnowledgePageIndexSettings>;

export type KnowledgePageSource = Selectable<KnowledgePageSources>;
export type InsertableKnowledgePageSource = Insertable<KnowledgePageSources>;

export type KnowledgeParentSection = Selectable<KnowledgeParentSections>;
export type InsertableKnowledgeParentSection =
  Insertable<KnowledgeParentSections>;
export type KnowledgeParentSectionSource =
  Selectable<KnowledgeParentSectionSources>;
export type InsertableKnowledgeParentSectionSource =
  Insertable<KnowledgeParentSectionSources>;

type SelectedKnowledgeChunk = Selectable<KnowledgeChunks>;
type KnowledgeChunkMigrationColumn =
  | 'chunkRole'
  | 'embeddingDurationMs'
  | 'embeddingTotalTokens'
  | 'embeddingDimensions'
  | 'embeddingModel'
  | 'embeddingProfile'
  | 'endOffset'
  | 'headingPath'
  | 'parentSectionId'
  | 'retrievalChannel'
  | 'searchTsv'
  | 'searchTsvZh'
  | 'stableKey'
  | 'startOffset';
export type KnowledgeChunk = Omit<
  SelectedKnowledgeChunk,
  KnowledgeChunkMigrationColumn | 'embedding'
> & {
  embedding: SelectedKnowledgeChunk['embedding'] | JsonValue;
} & Partial<Pick<SelectedKnowledgeChunk, KnowledgeChunkMigrationColumn>>;
export type InsertableKnowledgeChunk = Insertable<KnowledgeChunks>;
export type UpdatableKnowledgeChunk = Updateable<Omit<KnowledgeChunks, 'id'>>;

export type KnowledgeChunkSource = Selectable<KnowledgeChunkSources>;
export type InsertableKnowledgeChunkSource = Insertable<KnowledgeChunkSources>;

export type KnowledgeChunkAttachment = Selectable<KnowledgeChunkAttachments>;
export type InsertableKnowledgeChunkAttachment =
  Insertable<KnowledgeChunkAttachments>;

export type KnowledgeLink = Selectable<KnowledgeLinks>;
export type InsertableKnowledgeLink = Insertable<KnowledgeLinks>;
export type UpdatableKnowledgeLink = Updateable<Omit<KnowledgeLinks, 'id'>>;

export type KnowledgeLinkSource = Selectable<KnowledgeLinkSources>;
export type InsertableKnowledgeLinkSource = Insertable<KnowledgeLinkSources>;

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
export type KnowledgeEmbeddingRebuildBatch =
  Selectable<KnowledgeEmbeddingRebuildBatches>;
export type InsertableKnowledgeEmbeddingRebuildBatch =
  Insertable<KnowledgeEmbeddingRebuildBatches>;

export type KnowledgeQuarantinedArtifact =
  Selectable<KnowledgeQuarantinedArtifacts>;
export type InsertableKnowledgeQuarantinedArtifact =
  Insertable<KnowledgeQuarantinedArtifacts>;

export type Workspace = Selectable<Workspaces>;
export type InsertableWorkspace = Insertable<Workspaces>;
export type UpdatableWorkspace = Updateable<Omit<Workspaces, 'id'>>;

export type WorkspaceInvitation = Selectable<WorkspaceInvitations>;
export type InsertableWorkspaceInvitation = Insertable<WorkspaceInvitations>;
export type UpdatableWorkspaceInvitation = Updateable<
  Omit<WorkspaceInvitations, 'id'>
>;

export type User = Selectable<Users>;
export type InsertableUser = Insertable<Users>;
export type UpdatableUser = Updateable<Omit<Users, 'id'>>;

export type Space = Selectable<Spaces>;
export type InsertableSpace = Insertable<Spaces>;
export type UpdatableSpace = Updateable<Omit<Spaces, 'id'>>;

export type SpaceMember = Selectable<SpaceMembers>;
export type InsertableSpaceMember = Insertable<SpaceMembers>;
export type UpdatableSpaceMember = Updateable<Omit<SpaceMembers, 'id'>>;

export type ExtendedGroup = Groups & { memberCount: number };

export type Group = Selectable<Groups>;
export type InsertableGroup = Insertable<Groups>;
export type UpdatableGroup = Updateable<Omit<Groups, 'id'>>;

export type GroupUser = Selectable<GroupUsers>;
export type InsertableGroupUser = Insertable<GroupUsers>;
export type UpdatableGroupUser = Updateable<Omit<GroupUsers, 'id'>>;

export type Page = Selectable<Pages>;
export type InsertablePage = Insertable<Pages>;
export type UpdatablePage = Updateable<Omit<Pages, 'id'>>;

export type PageHistory = Selectable<History>;
export type InsertablePageHistory = Insertable<History>;
export type UpdatablePageHistory = Updateable<Omit<History, 'id'>>;

export type Comment = Selectable<Comments>;
export type InsertableComment = Insertable<Comments>;
export type UpdatableComment = Updateable<Omit<Comments, 'id'>>;

export type Attachment = Selectable<Attachments>;
export type InsertableAttachment = Insertable<Attachments>;
export type UpdatableAttachment = Updateable<Omit<Attachments, 'id'>>;

export type UserToken = Selectable<UserTokens>;
export type InsertableUserToken = Insertable<UserTokens>;
export type UpdatableUserToken = Updateable<Omit<UserTokens, 'id'>>;

export type Backlink = Selectable<Backlinks>;
export type InsertableBacklink = Insertable<Backlink>;
export type UpdatableBacklink = Updateable<Omit<Backlink, 'id'>>;

export type Billing = Selectable<BillingSubscription>;
export type InsertableBilling = Insertable<BillingSubscription>;
export type UpdatableBilling = Updateable<Omit<BillingSubscription, 'id'>>;

export type AuthProvider = Selectable<AuthProviders>;
export type InsertableAuthProvider = Insertable<AuthProviders>;
export type UpdatableAuthProvider = Updateable<Omit<AuthProviders, 'id'>>;

export type AuthAccount = Selectable<AuthAccounts>;
export type InsertableAuthAccount = Insertable<AuthAccounts>;
export type UpdatableAuthAccount = Updateable<Omit<AuthAccounts, 'id'>>;

export type Share = Selectable<Shares>;
export type InsertableShare = Insertable<Shares>;
export type UpdatableShare = Updateable<Omit<Shares, 'id'>>;

export type Favorite = Selectable<Favorites>;
export type InsertableFavorite = Insertable<Favorites>;
export type UpdatableFavorite = Updateable<Omit<Favorites, 'id'>>;

export type PageTransclusion = Selectable<PageTransclusions>;
export type InsertablePageTransclusion = Insertable<PageTransclusions>;
export type UpdatablePageTransclusion = Updateable<
  Omit<PageTransclusions, 'id'>
>;

export type PageTransclusionReference = Selectable<PageTransclusionReferences>;
export type InsertablePageTransclusionReference =
  Insertable<PageTransclusionReferences>;
export type UpdatablePageTransclusionReference = Updateable<
  Omit<PageTransclusionReferences, 'id'>
>;

export type FileTask = Selectable<FileTasks>;
export type InsertableFileTask = Insertable<FileTasks>;
export type UpdatableFileTask = Updateable<Omit<FileTasks, 'id'>>;

export type UserMFA = Selectable<_UserMFA>;
export type InsertableUserMFA = Insertable<_UserMFA>;
export type UpdatableUserMFA = Updateable<Omit<_UserMFA, 'id'>>;

export type ApiKey = Selectable<ApiKeys>;
export type InsertableApiKey = Insertable<ApiKeys>;
export type UpdatableApiKey = Updateable<Omit<ApiKeys, 'id'>>;
export type ApiKeySpace = Selectable<ApiKeySpaces>;
export type InsertableApiKeySpace = Insertable<ApiKeySpaces>;

export type AiModelConfig = Selectable<AiModelConfigs>;
export type InsertableAiModelConfig = Insertable<AiModelConfigs>;
export type UpdatableAiModelConfig = Updateable<Omit<AiModelConfigs, 'id'>>;

export type ScimToken = Selectable<ScimTokens>;
export type InsertableScimToken = Insertable<ScimTokens>;
export type UpdatableScimToken = Updateable<Omit<ScimTokens, 'id'>>;

export type PageEmbedding = Selectable<PageEmbeddings>;
export type InsertablePageEmbedding = Insertable<PageEmbeddings>;
export type UpdatablePageEmbedding = Updateable<Omit<PageEmbeddings, 'id'>>;

export type Notification = Selectable<Notifications>;
export type InsertableNotification = Insertable<Notifications>;
export type UpdatableNotification = Updateable<Omit<Notifications, 'id'>>;

export type Watcher = Selectable<Watchers>;
export type InsertableWatcher = Insertable<Watchers>;
export type UpdatableWatcher = Updateable<Omit<Watchers, 'id'>>;

export type Label = Selectable<Labels>;
export type InsertableLabel = Insertable<Labels>;
export type UpdatableLabel = Updateable<Omit<Labels, 'id'>>;

export type PageLabel = Selectable<PageLabels>;
export type InsertablePageLabel = Insertable<PageLabels>;

export type PageAccess = Selectable<_PageAccess>;
export type InsertablePageAccess = Insertable<_PageAccess>;
export type UpdatablePageAccess = Updateable<Omit<_PageAccess, 'id'>>;

export type PageVisit = Selectable<PageVisits>;
export type InsertablePageVisit = Insertable<PageVisits>;

export type PagePermission = Selectable<_PagePermissions>;
export type InsertablePagePermission = Insertable<_PagePermissions>;
export type UpdatablePagePermission = Updateable<Omit<_PagePermissions, 'id'>>;

export type PageVerification = Selectable<_PageVerifications>;
export type InsertablePageVerification = Insertable<_PageVerifications>;
export type UpdatablePageVerification = Updateable<
  Omit<_PageVerifications, 'id'>
>;

export type PageVerifier = Selectable<_PageVerifiers>;
export type InsertablePageVerifier = Insertable<_PageVerifiers>;

export type UserSession = Selectable<UserSessions>;
export type InsertableUserSession = Insertable<UserSessions>;
export type UpdatableUserSession = Updateable<Omit<UserSessions, 'id'>>;

export type Audit = Selectable<_Audit>;
export type InsertableAudit = Insertable<_Audit>;
export type UpdatableAudit = Updateable<Omit<_Audit, 'id'>>;

export type Template = Selectable<Templates>;
export type InsertableTemplate = Insertable<Templates>;
export type UpdatableTemplate = Updateable<Omit<Templates, 'id'>>;
