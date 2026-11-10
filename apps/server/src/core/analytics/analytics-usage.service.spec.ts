import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AnalyticsUsageService } from './analytics-usage.service';
import { AnalyticsUsageQueryDto } from './dto/analytics.dto';
import { AnalyticsController } from './analytics.controller';
import { resolveRange } from './analytics.service';

describe('analytics usage boundaries', () => {
  it('resolves today, yesterday and inclusive custom dates in Shanghai time', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    expect(resolveRange('today', now)).toEqual({
      from: new Date('2026-11-08T16:00:00Z'),
      to: new Date('2026-11-09T16:00:00Z'),
    });
    expect(resolveRange('yesterday', now)).toEqual({
      from: new Date('2026-11-07T16:00:00Z'),
      to: new Date('2026-11-08T16:00:00Z'),
    });
    expect(
      resolveRange('custom', now, { from: '2026-11-01', to: '2026-11-09' }),
    ).toEqual({
      from: new Date('2026-10-31T16:00:00Z'),
      to: new Date('2026-11-09T16:00:00Z'),
    });
  });

  it.each([
    {},
    { from: '2026-02-30', to: '2026-03-02' },
    { from: '2026-11-10', to: '2026-11-09' },
    { from: '2024-01-01', to: '2026-11-09' },
  ])('rejects invalid or excessive custom dates: %j', (dates) => {
    expect(() => resolveRange('custom', new Date(), dates)).toThrow();
  });

  it('validates query limits, enum values, entity IDs and SQL sort input', async () => {
    const valid = plainToInstance(AnalyticsUsageQueryDto, {
      page: '2',
      limit: '20',
    });
    expect(await validate(valid)).toHaveLength(0);
    expect(valid.page).toBe(2);
    for (const value of [
      { page: '0' },
      { page: '1.5' },
      { limit: '101' },
      { groupBy: 'workspace' },
      { entityId: "' OR true" },
      { sort: 'ops; drop table users' },
      { range: 'custom', from: 'x' },
    ]) {
      expect(
        (await validate(plainToInstance(AnalyticsUsageQueryDto, value))).length,
      ).toBeGreaterThan(0);
    }
  });

  it('rejects space attribution and uses only the authenticated workspace', async () => {
    const repo = {
      overview: jest.fn().mockResolvedValue({}),
      events: jest.fn().mockResolvedValue({}),
    };
    const service = new AnalyticsUsageService(repo as never);
    await expect(
      service.query(
        'ws-a',
        Object.assign(new AnalyticsUsageQueryDto(), { spaceId: 'space-b' }),
      ),
    ).rejects.toThrow('workspace-wide');
    await service.query('ws-a', new AnalyticsUsageQueryDto());
    expect(repo.overview).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-a' }),
      expect.anything(),
    );
  });

  it('denies both summary and event access before querying for non-admin users', async () => {
    const usage = { query: jest.fn() };
    const ability = {
      createForUser: jest.fn().mockReturnValue({ cannot: () => true }),
    };
    const controller = new AnalyticsController(
      {} as never,
      ability as never,
      usage as never,
    );
    await expect(
      controller.usage(
        new AnalyticsUsageQueryDto(),
        {} as never,
        { id: 'ws' } as never,
      ),
    ).rejects.toThrow();
    await expect(
      controller.events(
        new AnalyticsUsageQueryDto(),
        {} as never,
        { id: 'ws' } as never,
      ),
    ).rejects.toThrow();
    expect(usage.query).not.toHaveBeenCalled();
  });
});
