import { DB } from '@akasha/db/types/db';
import { PageEmbeddings } from '@akasha/db/types/embeddings.types';
import {
  WeeklyReportRecords,
  WeeklyReportSaveReceipts,
  WeeklyReportOutbox,
} from './weekly-report.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
  weeklyReportRecords: WeeklyReportRecords;
  weeklyReportSaveReceipts: WeeklyReportSaveReceipts;
  weeklyReportOutbox: WeeklyReportOutbox;
}
