import { JSONContent } from "@tiptap/core";

export type TemplateScope = "all" | "allSpaces" | "space" | "available";

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
  allSpaces: boolean;
  spaceIds: string[];
  otherSpaceCount: number;
  workspaceId: string;
  creatorId: string | null;
  lastUpdatedById: string | null;
  creator?: { id: string; name: string; avatarUrl?: string | null } | null;
  content?: JSONContent;
  outline?: TemplateOutlineItem[];
  canManage: boolean;
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
