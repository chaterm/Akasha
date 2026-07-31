import { MentionNode } from '../../../common/helpers/prosemirror/utils';

export interface IPageBacklinkJob {
  pageId: string;
  workspaceId: string;
  mentions: MentionNode[];
  internalLinkSlugIds?: string[];
}

export interface IAddPageWatchersJob {
  userIds: string[];
  pageId: string;
  spaceId: string;
  workspaceId: string;
}

export interface IStripeSeatsSyncJob {
  workspaceId: string;
}

export interface IPageHistoryJob {
  pageId: string;
}

export interface INotificationCreateJob {
  userId: string;
  workspaceId: string;
  type: string;
  actorId?: string;
  pageId?: string;
  spaceId?: string;
  commentId?: string;
  data?: Record<string, unknown>;
}

export interface ICommentNotificationJob {
  commentId: string;
  parentCommentId?: string;
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  mentionedUserIds: string[];
  notifyWatchers: boolean;
}

export interface ICommentResolvedNotificationJob {
  commentId: string;
  commentCreatorId: string;
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
}

export interface IPageMentionNotificationJob {
  userMentions: { userId: string; mentionId: string; creatorId: string }[];
  oldMentionedUserIds: string[];
  pageId: string;
  spaceId: string;
  workspaceId: string;
}

export interface IPageUpdateNotificationJob {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorIds: string[];
}

export interface IPermissionGrantedNotificationJob {
  userIds: string[];
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  role: string;
}

export interface IVerificationExpiringNotificationJob {
  verificationId: string;
}

export interface IVerificationExpiredNotificationJob {
  verificationId: string;
}

export interface IVerificationReconcileJob {
  // no payload
}

export interface IPageVerifiedNotificationJob {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  verifierIds: string[];
}

export interface IApprovalRequestedNotificationJob {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  verifierIds: string[];
}

export interface IApprovalRejectedNotificationJob {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  actorId: string;
  requestedById: string;
  comment?: string;
}

export interface IKnowledgeCompileSpaceJob {
  workspaceId: string;
  spaceId: string;
  confirmationSpaceName?: string;
  trigger?: 'manual_compile' | 'retry_compile' | 'page_update';
}

export interface IKnowledgeCompilePagesJob {
  workspaceId: string;
  spaceId: string;
  sourcePageIds: string[];
  sourceVersion?: string;
  sourceContentHash?: string;
  spaceRunId?: string;
  knowledgeGeneration?: number;
  trigger?:
    | 'manual_compile'
    | 'retry_compile'
    | 'page_update'
    | 'page_created'
    | 'page_restored';
}

export interface IKnowledgeCompilePageImagesJob {
  workspaceId: string;
  spaceId: string;
  sourcePageId: string;
  sourceVersion: string;
  sourceContentHash: string;
  spaceRunId?: string;
  knowledgeGeneration: number;
  images: Array<{
    attachmentId: string;
    fileName: string;
    mimeType:
      | 'image/jpeg'
      | 'image/png'
      | 'image/apng'
      | 'image/gif'
      | 'image/webp'
      | 'image/avif'
      | 'image/tiff'
      | 'image/bmp';
    fileSize: number | null;
    attachmentVersion: string;
    altText?: string;
  }>;
}

export interface IKnowledgeMergePageImagesJob extends IKnowledgeCompilePageImagesJob {
  effectiveKnowledgeHash: string;
}

export interface IKnowledgeAggregateSpaceJob {
  workspaceId: string;
  spaceId: string;
  spaceRunId: string;
  knowledgeGeneration: number;
  phase?: 'initial_aggregate' | 'final_aggregate';
}

export interface IKnowledgeRebuildEmbeddingsJob {
  workspaceId: string;
  spaceId: string;
  afterChunkId?: string;
}

export interface IKnowledgeReindexAccessJob {
  workspaceId: string;
  spaceId?: string;
  sourcePageIds?: string[];
  afterSourcePageId?: string;
}

export interface IKnowledgeMarkSourcesStaleJob {
  workspaceId: string;
  sourcePageIds?: string[];
  spaceId?: string;
  mode?: 'all_dependencies' | 'source_artifacts';
}

export interface IReviewDiscoverJob {
  workspaceId: string;
  spaceId: string;
  limit?: number;
}

export interface IReviewNegotiateJob {
  workspaceId: string;
  spaceId: string;
  item: unknown;
  feedback?: string;
}
