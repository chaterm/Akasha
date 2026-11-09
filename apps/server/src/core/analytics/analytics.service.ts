import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import {
  AnalyticsEventRepo,
  AnalyticsRange,
  DailyRow,
} from '@akasha/db/repos/analytics/analytics-event.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { User, Workspace } from '@akasha/db/types/entity.types';
import {
  ANALYTICS_ROUTES,
  AnalyticsRangeKey,
  AnalyticsRoute,
  TrackPageViewDto,
} from './dto/analytics.dto';
import { groupAgentOpsByCategory } from './agent-op-category';

// Applies to page_view and agent_op events.
const EVENT_RETENTION_DAYS = 400;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OVERVIEW_CACHE_SECONDS = 5 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
// Matches ANALYTICS_TIMEZONE (Asia/Shanghai, no DST).
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

const RANGE_DAYS: Partial<Record<AnalyticsRangeKey, number>> = {
  today: 1,
  yesterday: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** [from, to) covering the last `days` local days, today included. */
export function resolveRange(
  key: AnalyticsRangeKey,
  now: Date = new Date(),
  custom?: { from?: string; to?: string },
): { from: Date; to: Date } {
  if (key === 'custom') {
    const parseDay = (value?: string) => {
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new BadRequestException('Start and end dates are required');
      }
      const date = new Date(`${value}T00:00:00+08:00`);
      if (
        !Number.isFinite(date.getTime()) ||
        new Date(date.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10) !==
          value
      ) {
        throw new BadRequestException('Invalid analytics date');
      }
      return date;
    };
    const from = parseDay(custom?.from);
    const to = new Date(parseDay(custom?.to).getTime() + DAY_MS);
    if (
      to <= from ||
      to.getTime() - from.getTime() > EVENT_RETENTION_DAYS * DAY_MS
    ) {
      throw new BadRequestException(
        'Select an ordered date range of at most 400 days',
      );
    }
    return { from, to };
  }
  const days = RANGE_DAYS[key];
  const localMidnight =
    Math.floor((now.getTime() + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
  const to = new Date(localMidnight + (key === 'yesterday' ? 0 : DAY_MS));
  const from = new Date(to.getTime() - days * DAY_MS);
  return { from, to };
}

export function normalizeRoute(route: string): AnalyticsRoute {
  return (ANALYTICS_ROUTES as readonly string[]).includes(route)
    ? (route as AnalyticsRoute)
    : 'other';
}

/**
 * DAU/WAU/MAU headline numbers. WAU/MAU are taken at the last day of the
 * range; stickiness is the average of daily DAU/MAU, skipping days with no
 * monthly actives.
 */
export function summarizeActivity(daily: DailyRow[]) {
  if (daily.length === 0) {
    return { avgDau: 0, wau: 0, mau: 0, stickiness: 0 };
  }
  const last = daily[daily.length - 1];
  const avgDau = daily.reduce((sum, row) => sum + row.uv, 0) / daily.length;
  const ratios = daily.filter((row) => row.mau > 0).map((r) => r.uv / r.mau);
  const stickiness =
    ratios.length > 0
      ? ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length
      : 0;
  return {
    avgDau: Math.round(avgDau),
    wau: last.wau,
    mau: last.mau,
    stickiness: Math.round(stickiness * 1000) / 1000,
  };
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly redis: Redis;

  constructor(
    private readonly analyticsEventRepo: AnalyticsEventRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly pageRepo: PageRepo,
    redisService: RedisService,
  ) {
    this.redis = redisService.getOrThrow();
  }

  async trackPageView(
    dto: TrackPageViewDto,
    user: User,
    workspace: Workspace,
  ): Promise<void> {
    const route = normalizeRoute(dto.route);
    let spaceId: string | null = null;
    let pageId: string | null = null;

    // Ids are resolved server-side and scoped to the caller's workspace;
    // anything unresolvable is recorded without attribution.
    if (dto.pageSlugId) {
      const page = await this.pageRepo.findById(dto.pageSlugId);
      if (page && !page.deletedAt && page.workspaceId === workspace.id) {
        pageId = page.id;
        spaceId = page.spaceId;
      }
    }
    if (!spaceId && dto.spaceSlug) {
      const space = await this.spaceRepo.findBySlug(
        dto.spaceSlug,
        workspace.id,
      );
      spaceId = space?.id ?? null;
    }

    await this.analyticsEventRepo.insertPageView({
      workspaceId: workspace.id,
      userId: user.id,
      route,
      spaceId,
      pageId,
    });
  }

  async getOverview(input: {
    workspace: Workspace;
    range: AnalyticsRangeKey;
    spaceId?: string;
    from?: string;
    to?: string;
  }) {
    const { workspace, spaceId } = input;
    if (spaceId) {
      const space = await this.spaceRepo.findById(spaceId, workspace.id);
      if (!space) throw new BadRequestException('Space not found');
    }

    const { from, to } = resolveRange(input.range, new Date(), input);
    const cacheKey = `analytics:overview:${workspace.id}:${from.toISOString()}:${to.toISOString()}:${spaceId ?? 'all'}`;
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const range: AnalyticsRange = {
      workspaceId: workspace.id,
      from,
      to,
      spaceId,
    };

    const [
      trackingSince,
      cards,
      daily,
      topPages,
      topUsers,
      topSpaces,
      routes,
      agents,
    ] = await Promise.all([
      this.analyticsEventRepo.findTrackingSince(workspace.id),
      this.analyticsEventRepo.summarize(range),
      this.analyticsEventRepo.dailySeries(range),
      this.analyticsEventRepo.topPages(range),
      this.analyticsEventRepo.topUsers(range),
      spaceId ? null : this.analyticsEventRepo.topSpaces(range),
      spaceId ? null : this.analyticsEventRepo.routeBreakdown(range),
      // Agents act across spaces, so they are workspace-scope only.
      spaceId ? null : this.analyticsEventRepo.agentSummary(range),
    ]);

    const overview = {
      range: {
        key: input.range,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      scope: spaceId ? 'space' : 'workspace',
      trackingSince: trackingSince?.toISOString() ?? null,
      cards: { ...cards, ...summarizeActivity(daily) },
      series: { daily },
      rankings: {
        topPages,
        topUsers,
        ...(topSpaces ? { topSpaces } : {}),
        ...(routes ? { routeBreakdown: routes } : {}),
      },
      ...(agents
        ? {
            agents: {
              ...agents,
              // Categories use every op; the per-op list is trimmed for display.
              byCategory: groupAgentOpsByCategory(agents.byOp),
              byOp: agents.byOp.slice(0, 15),
            },
          }
        : {}),
    };

    await this.writeCache(cacheKey, overview);
    return overview;
  }

  @Interval('analytics-event-cleanup', CLEANUP_INTERVAL_MS)
  async cleanupExpiredEvents(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * DAY_MS);
      const deleted =
        await this.analyticsEventRepo.deleteExpiredEventsBefore(cutoff);
      if (deleted > 0) {
        this.logger.log(`Deleted ${deleted} expired analytics events`);
      }
    } catch (error) {
      this.logger.error('Failed to clean up analytics events', error);
    }
  }

  private async readCache(key: string): Promise<any | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, value: unknown): Promise<void> {
    try {
      await this.redis.set(
        key,
        JSON.stringify(value),
        'EX',
        OVERVIEW_CACHE_SECONDS,
      );
    } catch {
      // Cache is best-effort.
    }
  }
}
