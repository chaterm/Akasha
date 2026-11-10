import { z } from 'zod/v4';
import { DEFAULT_WEEKLY_REPORT_TIMEZONE } from '../weekly-report/weekly-report-period';

export const listTemplatesSchema = {
  query: z.string().max(1000).optional(),
  spaceId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(4096).optional(),
};

export const getTemplateSchema = {
  templateId: z.string().uuid(),
  spaceId: z.string().uuid(),
};

export const prepareWeeklyReportSchema = {
  period: z.enum(['this_week', 'last_week', 'custom']).default('this_week'),
  periodStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  periodEnd: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  timezone: z
    .string()
    .min(1)
    .max(100)
    .default(DEFAULT_WEEKLY_REPORT_TIMEZONE)
    .describe(
      'Defaults to Asia/Shanghai automatically. Do not ask the user to choose a timezone; override only when the user explicitly requests another IANA timezone.',
    ),
  templateId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe(
      'Template UUID for this report. Omit to use the MCP connection default (or builtin if unset). Set null to explicitly use the builtin template.',
    ),
  parentPageId: z
    .string()
    .min(1)
    .max(64)
    .nullable()
    .optional()
    .describe(
      'Parent Page UUID or ten-character short ID (an optional leading dash is accepted). Resolve full page URLs with get_citation_page first. Omit to inherit the connection default; null selects personal-space 周报.',
    ),
};

export const saveWeeklyReportSchema = {
  saveToken: z.string().min(1).max(16384),
  title: z.string().min(1).max(200).optional(),
  // Detailed schema/content checks belong to the first-write domain path.
  // A successful token replay must remain independent of new document content.
  content: z.record(z.string(), z.unknown()),
};
