import { JSONContent } from "@tiptap/core";

export type TemplateScope = "all" | "allSpaces" | "space" | "available";

/** 列表接口返回的正文结构概要，用于卡片缩略图。 */
export type TemplateOutlineItem =
  | { kind: "heading"; level: number; text: string }
  | { kind: "text"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "task"; text: string }
  | { kind: "callout"; tone: string; text: string }
  /** table / code / columns / toc / details */
  | { kind: "block"; label: string };

export interface PageTemplate {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  /** true：所有空间可用；否则只在 spaceIds 中可用 */
  allSpaces: boolean;
  /** 当前用户能访问的已指定空间 */
  spaceIds: string[];
  /** 用户看不到的已指定空间数量 */
  otherSpaceCount: number;
  workspaceId: string;
  creatorId: string | null;
  lastUpdatedById: string | null;
  creator?: { id: string; name: string; avatarUrl?: string | null } | null;
  content?: JSONContent;
  /** 仅列表接口返回 */
  outline?: TemplateOutlineItem[];
  canManage: boolean;
  /** 代码内置的公共模板：所有空间可用、只读 */
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateListParams {
  scope?: TemplateScope;
  spaceId?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface TemplateAvailability {
  allSpaces: boolean;
  spaceIds: string[];
}

export interface TemplateDraft extends Partial<TemplateAvailability> {
  title?: string;
  description?: string | null;
  icon?: string | null;
  content?: JSONContent;
}
