import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  IsInt,
  Min,
  Max,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

export const ANALYTICS_ROUTES = [
  'home',
  'ai',
  'spaces',
  'favorites',
  'space.home',
  'space.page',
  'space.trash',
  'graph',
  'knowledge.admin',
  'labels',
  'templates',
  'settings',
  'analytics',
  'other',
] as const;

export type AnalyticsRoute = (typeof ANALYTICS_ROUTES)[number];

export const ANALYTICS_RANGES = [
  'today',
  'yesterday',
  '7d',
  '30d',
  '90d',
  'custom',
] as const;

export type AnalyticsRangeKey = (typeof ANALYTICS_RANGES)[number];

export class TrackPageViewDto {
  // Unknown routes are coerced to 'other' instead of rejected, so an older
  // client never fails tracking after a route is added.
  @IsString()
  @MaxLength(64)
  route: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  spaceSlug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  pageSlugId?: string;
}

export class AnalyticsOverviewQueryDto {
  @IsOptional()
  @IsIn(ANALYTICS_RANGES)
  range: AnalyticsRangeKey = '30d';

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;
}

export class AnalyticsUsageQueryDto extends AnalyticsOverviewQueryDto {
  @IsOptional()
  @IsIn(['agent', 'user', 'key'])
  groupBy: 'agent' | 'user' | 'key' = 'key';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsIn(['agent', 'personal', 'sso', 'unknown'])
  keyType?: string;

  @IsOptional()
  @IsIn(['api', 'mcp'])
  channel?: string;

  @IsOptional()
  @IsIn(['ok', 'error', 'called'])
  outcome?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  op?: string;

  @IsOptional()
  @Matches(
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|__none__)$/i,
  )
  entityId?: string;

  @IsOptional()
  @IsIn(['ops', 'failedOps', 'lastOpAt'])
  sort: 'ops' | 'failedOps' | 'lastOpAt' = 'ops';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction: 'asc' | 'desc' = 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
