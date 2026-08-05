import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const RUN_STATUSES = [
  'queued',
  'compiling',
  'aggregate_pending',
  'aggregating',
  'succeeded',
  'partial',
  'failed',
  'superseded',
  'cancelled',
] as const;

// Per-page compilation statuses recorded on knowledge_space_compile_run_pages
// (matches chk_knowledge_space_compile_run_pages_status).
const PAGE_LOG_STATUSES = [
  'pending',
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const;

const DELAYED_PAGE_STATUSES = ['waiting', 'due'] as const;

const RUN_PHASES = [
  'text',
  'initial_aggregate',
  'images',
  'image_merge',
  'final_aggregate',
  'complete',
] as const;

export class AdminKnowledgeRunSummaryDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsUUID(undefined, { each: true })
  spaceIds?: string[];
}

export class AdminKnowledgeRunListDto extends AdminKnowledgeRunSummaryDto {
  @IsOptional()
  @IsArray()
  @IsIn(RUN_STATUSES, { each: true })
  statuses?: (typeof RUN_STATUSES)[number][];

  @IsOptional()
  @IsArray()
  @IsIn(RUN_PHASES, { each: true })
  phases?: (typeof RUN_PHASES)[number][];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AdminKnowledgeDelayedPageListDto extends AdminKnowledgeRunSummaryDto {
  @IsOptional()
  @IsArray()
  @IsIn(DELAYED_PAGE_STATUSES, { each: true })
  statuses?: (typeof DELAYED_PAGE_STATUSES)[number][];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AdminKnowledgeImmediateCompileDelayedPageDto {
  @IsString()
  @MaxLength(255)
  confirmationPageName: string;
}

export class AdminKnowledgeRemoveDelayedPageDto {
  @IsString()
  @MaxLength(255)
  confirmationPageName: string;
}

export class AdminKnowledgeQuarantineListDto extends AdminKnowledgeRunSummaryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AdminKnowledgeRunPagesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AdminKnowledgePageLogDto extends AdminKnowledgeRunSummaryDto {
  @IsOptional()
  @IsArray()
  @IsIn(PAGE_LOG_STATUSES, { each: true })
  statuses?: (typeof PAGE_LOG_STATUSES)[number][];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  // ISO-8601 timestamps bounding the most-recent-compilation time window.
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
