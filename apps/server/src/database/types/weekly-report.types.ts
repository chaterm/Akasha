import type { Generated } from 'kysely';
import type { WeeklyReportEffect } from '../../core/weekly-report/weekly-report.types';

export interface WeeklyReportRecords {
  id: string;
  workspaceId: string;
  userId: string;
  spaceId: string;
  parentPageId: string;
  pageId: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  templateId: string;
  templateFingerprint: string;
  createdAt: Generated<Date>;
}

export interface WeeklyReportSaveReceipts {
  saveId: string;
  workspaceId: string;
  userId: string;
  reportRecordId: string;
  parentCreated: boolean;
  createdAt: Generated<Date>;
}

export interface WeeklyReportOutbox {
  id: string;
  workspaceId: string;
  pageId: string;
  userId: string;
  effect: WeeklyReportEffect;
  attempts: Generated<number>;
  availableAt: Generated<Date>;
  deliveredAt: Date | null;
  createdAt: Generated<Date>;
}
