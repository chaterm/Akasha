import { BadRequestException } from '@nestjs/common';
import { validate as isUuid } from 'uuid';
import type { McpToolContext } from '../mcp/mcp-tool-registry';
import type { PrepareWeeklyReportInput } from './weekly-report.types';

type Headers = Record<string, string | string[] | undefined>;

export function normalizeWeeklyReportParentId(
  value: string,
): string | undefined {
  if (isUuid(value)) return value;
  if (/^-?[A-Za-z0-9]{10}$/.test(value)) return value.replace(/^-/, '');
  return undefined;
}

export function readWeeklyReportDefaults(
  headers: Headers,
): McpToolContext['weeklyReportDefaults'] {
  const defaults: NonNullable<McpToolContext['weeklyReportDefaults']> = {};
  for (const [field, name] of [
    ['templateId', 'x-akasha-weekly-template-id'],
    ['parentPageId', 'x-akasha-weekly-parent-page-id'],
  ] as const) {
    const value = headers[name];
    if (value !== undefined)
      defaults[field] = (Array.isArray(value) ? value.join(',') : value).trim();
  }
  return Object.keys(defaults).length ? defaults : undefined;
}

export function resolveWeeklyReportDefaults(
  ctx: McpToolContext,
  input: PrepareWeeklyReportInput,
): PrepareWeeklyReportInput {
  const resolved = { ...input };
  for (const field of ['templateId', 'parentPageId'] as const) {
    const value =
      input[field] === undefined
        ? ctx.weeklyReportDefaults?.[field]
        : input[field];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== 'string' ||
        (field === 'templateId'
          ? !isUuid(value)
          : !normalizeWeeklyReportParentId(value)))
    ) {
      throw new BadRequestException({
        code: 'INVALID_ARGUMENT',
        message:
          field === 'parentPageId'
            ? 'Invalid weekly report parentPageId; use a page UUID or ten-character page short ID'
            : 'Invalid weekly report templateId; use a template UUID',
        details: {
          field,
          source: input[field] === undefined ? 'connection' : 'argument',
        },
      });
    }
    resolved[field] =
      field === 'parentPageId' && typeof value === 'string'
        ? normalizeWeeklyReportParentId(value)
        : value;
  }
  return resolved;
}
