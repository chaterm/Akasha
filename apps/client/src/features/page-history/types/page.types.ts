interface IPageHistoryUser {
  id: string;
  name: string;
  avatarUrl: string;
}

export interface IPageHistory {
  id: string;
  pageId: string;
  title: string;
  content?: any;
  slug: string;
  icon: string;
  coverPhoto: string;
  version: number;
  lastUpdatedById: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  lastUpdatedBy: IPageHistoryUser;
  contributors?: IPageHistoryUser[];
}

export type PageHistoryDiffStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed"
  | "too_large";

export interface IPageHistoryDiffChange {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
  deletedText: string;
  addedSpecialNode: { pos: number; nodeEnd: number } | null;
  deletedSpecialNode: { nodeJSON: unknown } | null;
}

export interface IPageHistoryDiff {
  status: PageHistoryDiffStatus;
  fromHistoryId: string | null;
  fromTitle?: string | null;
  toHistoryId: string;
  algorithmVersion: string;
  schemaVersion: string;
  fromContentHash?: string | null;
  toContentHash?: string | null;
  changes: IPageHistoryDiffChange[];
  addedCount: number;
  deletedCount: number;
  errorCode?: string | null;
}
