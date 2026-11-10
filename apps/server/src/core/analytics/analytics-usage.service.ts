import { BadRequestException, Injectable } from '@nestjs/common';
import { AnalyticsUsageRepo } from '@akasha/db/repos/analytics/analytics-usage.repo';
import { AnalyticsUsageQueryDto } from './dto/analytics.dto';
import { resolveRange } from './analytics.service';

@Injectable()
export class AnalyticsUsageService {
  constructor(private readonly repo: AnalyticsUsageRepo) {}

  async query(
    workspaceId: string,
    query: AnalyticsUsageQueryDto,
    events = false,
  ) {
    if (query.spaceId) {
      throw new BadRequestException('Call statistics are workspace-wide');
    }
    const range = {
      workspaceId,
      ...resolveRange(query.range, new Date(), query),
    };
    return events
      ? this.repo.events(range, query)
      : this.repo.overview(range, query);
  }
}
