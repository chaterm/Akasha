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

export interface IKnowledgeSpaceSliceJob {
  workspaceId: string;
  spaceId: string;
  spaceRunId: string;
  knowledgeGeneration: number;
  phase: 'text' | 'image_merge';
  spaceJobSequence: number;
}

export interface IKnowledgeCompileImageJob {
  workspaceId: string;
  spaceId: string;
  spaceRunId: string;
  runImageId: string;
  knowledgeGeneration: number;
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

export interface IKnowledgeRetireSourcesJob {
  workspaceId: string;
  sourcePageIds: string[];
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
