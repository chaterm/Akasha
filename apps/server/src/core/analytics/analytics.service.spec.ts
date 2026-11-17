import { BadRequestException } from '@nestjs/common';
import {
  AnalyticsService,
  normalizeRoute,
  resolveRange,
  summarizeActivity,
} from './analytics.service';

describe('analytics helpers', () => {
  it('resolves ranges to whole Asia/Shanghai days, today included', () => {
    const now = new Date('2026-10-12T01:30:00.000Z');

    const { from, to } = resolveRange('7d', now);

    expect(to.toISOString()).toBe('2026-10-12T16:00:00.000Z');
    expect(from.toISOString()).toBe('2026-10-05T16:00:00.000Z');
  });

  it('treats late-night UTC as the next Shanghai day', () => {
    const now = new Date('2026-10-12T23:30:00.000Z');

    const { to } = resolveRange('30d', now);

    expect(to.toISOString()).toBe('2026-10-13T16:00:00.000Z');
  });

  it('summarizes DAU/WAU/MAU and stickiness', () => {
    const row = (uv: number, wau: number, mau: number) =>
      ({ uv, wau, mau }) as any;

    const result = summarizeActivity([
      row(10, 20, 40),
      row(0, 0, 0),
      row(20, 30, 50),
    ]);

    expect(result).toEqual({
      avgDau: 10,
      wau: 30,
      mau: 50,
      stickiness: 0.325,
    });
    expect(summarizeActivity([])).toEqual({
      avgDau: 0,
      wau: 0,
      mau: 0,
      stickiness: 0,
    });
  });

  it('coerces unknown routes to other', () => {
    expect(normalizeRoute('space.page')).toBe('space.page');
    expect(normalizeRoute('/s/abc/p/xyz')).toBe('other');
  });
});

describe('AnalyticsService', () => {
  const workspace = { id: 'ws-1' } as any;
  const user = { id: 'user-1' } as any;

  function createService() {
    const analyticsEventRepo = {
      insertPageView: jest.fn().mockResolvedValue(undefined),
      findTrackingSince: jest.fn().mockResolvedValue(null),
      summarize: jest.fn().mockResolvedValue({ pv: 1 }),
      dailySeries: jest.fn().mockResolvedValue([]),
      topPages: jest.fn().mockResolvedValue([]),
      topUsers: jest.fn().mockResolvedValue([]),
      topSpaces: jest.fn().mockResolvedValue([]),
      routeBreakdown: jest.fn().mockResolvedValue([]),
      agentSummary: jest.fn().mockResolvedValue({ totalAgents: 2 }),
    };
    const spaceRepo = {
      findBySlug: jest.fn(),
      findById: jest.fn(),
    };
    const pageRepo = { findById: jest.fn() };
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const service = new AnalyticsService(
      analyticsEventRepo as any,
      spaceRepo as any,
      pageRepo as any,
      { getOrThrow: () => redis } as any,
    );
    return { service, analyticsEventRepo, spaceRepo, pageRepo, redis };
  }

  it('attributes a page view to the page and its space', async () => {
    const { service, analyticsEventRepo, pageRepo } = createService();
    pageRepo.findById.mockResolvedValue({
      id: 'page-1',
      spaceId: 'space-1',
      workspaceId: 'ws-1',
      deletedAt: null,
    });

    await service.trackPageView(
      { route: 'space.page', spaceSlug: 'eng', pageSlugId: 'abc' },
      user,
      workspace,
    );

    expect(analyticsEventRepo.insertPageView).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      userId: 'user-1',
      route: 'space.page',
      spaceId: 'space-1',
      pageId: 'page-1',
    });
  });

  it('drops attribution for pages in another workspace', async () => {
    const { service, analyticsEventRepo, pageRepo, spaceRepo } =
      createService();
    pageRepo.findById.mockResolvedValue({
      id: 'page-x',
      spaceId: 'space-x',
      workspaceId: 'ws-other',
      deletedAt: null,
    });
    spaceRepo.findBySlug.mockResolvedValue(undefined);

    await service.trackPageView(
      { route: 'space.page', spaceSlug: 'eng', pageSlugId: 'abc' },
      user,
      workspace,
    );

    expect(spaceRepo.findBySlug).toHaveBeenCalledWith('eng', 'ws-1');
    expect(analyticsEventRepo.insertPageView).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: null, pageId: null }),
    );
  });

  it('rejects a space filter outside the workspace', async () => {
    const { service, spaceRepo } = createService();
    spaceRepo.findById.mockResolvedValue(undefined);

    await expect(
      service.getOverview({ workspace, range: '7d', spaceId: 'space-x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('omits workspace-only rankings when scoped to a space', async () => {
    const { service, spaceRepo, analyticsEventRepo } = createService();
    spaceRepo.findById.mockResolvedValue({ id: 'space-1' });

    const result: any = await service.getOverview({
      workspace,
      range: '7d',
      spaceId: 'space-1',
    });

    expect(result.scope).toBe('space');
    expect(result.rankings.topSpaces).toBeUndefined();
    expect(result.rankings.routeBreakdown).toBeUndefined();
    expect(result.agents).toBeUndefined();
    expect(analyticsEventRepo.topSpaces).not.toHaveBeenCalled();
    expect(analyticsEventRepo.agentSummary).not.toHaveBeenCalled();
  });

  it('serves cached overviews without querying', async () => {
    const { service, redis, analyticsEventRepo } = createService();
    redis.get.mockResolvedValue(JSON.stringify({ cached: true }));

    const result = await service.getOverview({ workspace, range: '30d' });

    expect(result).toEqual({ cached: true });
    expect(analyticsEventRepo.summarize).not.toHaveBeenCalled();
  });
});
