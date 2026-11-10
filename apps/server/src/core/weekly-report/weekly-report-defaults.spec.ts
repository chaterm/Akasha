import {
  readWeeklyReportDefaults,
  resolveWeeklyReportDefaults,
  normalizeWeeklyReportParentId,
} from './weekly-report-defaults';
import type { McpToolContext } from '../mcp/mcp-tool-registry';

const templateId = '9694050d-4ebc-59d6-8560-d88d7d0ecf45';
const parentPageId = 'dcaec16f-7579-5ebb-b38d-21f8f3b7c1ce';
const ctx = {
  weeklyReportDefaults: { templateId, parentPageId },
} as McpToolContext;

describe('Weekly report connection defaults', () => {
  it.each(['MJ3eqsj1Ac', '-MJ3eqsj1Ac'])(
    'accepts the unique browser short identifier %s',
    (value) => {
      expect(normalizeWeeklyReportParentId(value)).toBe('MJ3eqsj1Ac');
      expect(
        resolveWeeklyReportDefaults(
          { weeklyReportDefaults: { parentPageId: value } } as McpToolContext,
          {},
        ).parentPageId,
      ).toBe('MJ3eqsj1Ac');
    },
  );
  it('reads only the two preference headers and trims HTTP whitespace', () => {
    expect(
      readWeeklyReportDefaults({
        authorization: 'not-part-of-preferences',
        'x-akasha-weekly-template-id': ` ${templateId} `,
        'x-akasha-weekly-parent-page-id': parentPageId,
      }),
    ).toEqual({ templateId, parentPageId });
    expect(
      readWeeklyReportDefaults({ authorization: 'ignored' }),
    ).toBeUndefined();
  });

  it('inherits each missing argument independently without mutating the call', () => {
    const input = { templateId: null, period: 'this_week' as const };
    expect(resolveWeeklyReportDefaults(ctx, input)).toEqual({
      ...input,
      parentPageId,
    });
    expect(input).toEqual({ templateId: null, period: 'this_week' });
    expect(resolveWeeklyReportDefaults(ctx, { parentPageId: null })).toEqual({
      templateId,
      parentPageId: null,
    });
  });

  it('explicit IDs or null override malformed connection preferences', () => {
    const bad = {
      weeklyReportDefaults: { templateId: 'invalid', parentPageId: 'invalid' },
    } as McpToolContext;
    expect(
      resolveWeeklyReportDefaults(bad, { templateId, parentPageId }),
    ).toEqual({ templateId, parentPageId });
    expect(
      resolveWeeklyReportDefaults(bad, {
        templateId: null,
        parentPageId: null,
      }),
    ).toEqual({ templateId: null, parentPageId: null });
  });

  it.each([
    '',
    'invalid',
    'https://example.com/p/page',
    `${parentPageId},${parentPageId}`,
  ])(
    'rejects a malformed configured parent without defaulting to another location (%s)',
    (value) => {
      const context = {
        weeklyReportDefaults: { parentPageId: value },
      } as McpToolContext;
      expect(() => resolveWeeklyReportDefaults(context, {})).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'INVALID_ARGUMENT',
            details: { field: 'parentPageId', source: 'connection' },
          }),
        }),
      );
    },
  );

  it('does not throw at HTTP extraction for unrelated tools, but rejects duplicated header values at prepare', () => {
    const defaults = readWeeklyReportDefaults({
      'x-akasha-weekly-template-id': [templateId, templateId],
    });
    expect(defaults).toBeDefined();
    expect(() =>
      resolveWeeklyReportDefaults(
        { weeklyReportDefaults: defaults } as McpToolContext,
        {},
      ),
    ).toThrow();
  });
});
