import type { JSONContent } from '@tiptap/core';

export interface PrepareWeeklyReportInput {
  period?: 'this_week' | 'last_week' | 'custom';
  periodStart?: string;
  periodEnd?: string;
  timezone?: string;
  /** Omitted inherits connection settings; null explicitly uses the builtin. */
  templateId?: string | null;
  /** Omitted inherits connection settings; null explicitly uses the personal space. */
  parentPageId?: string | null;
}

export interface SaveWeeklyReportInput {
  saveToken: string;
  title?: string;
  content: JSONContent;
}

export interface WeeklyReportClaims {
  type: 'weekly_report_save';
  saveId: string;
  userId: string;
  workspaceId: string;
  spaceId: string;
  parentPageId: string | null;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  templateId: string;
  templateFingerprint: string;
}

export type WeeklyReportEffect =
  | 'search'
  | 'access'
  | 'compile'
  | 'watchers'
  | 'audit';

export interface WeeklyReportResult {
  pageId: string;
  url: string;
  title: string;
  spaceId: string;
  parentPageId: string;
  parentCreated: boolean;
  templateId: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  status: 'created' | 'existing' | 'replayed';
  replayed: boolean;
  locationChanged: boolean;
  /** The short first step created a draft whose full body still needs writing. */
  contentPending: boolean;
}
