import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
] as const;

const RUN_PHASES = [
  'text',
  'initial_aggregate',
  'images',
  'image_merge',
  'final_aggregate',
  'complete',
] as const;

export class AdminKnowledgeDiagnosticsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsUUID(undefined, { each: true })
  spaceIds?: string[];

  @IsOptional()
  @IsArray()
  @IsIn(
    ['not_started', 'queued', 'running', 'succeeded', 'skipped', 'failed'],
    {
      each: true,
    },
  )
  statuses?: Array<
    'not_started' | 'queued' | 'running' | 'succeeded' | 'skipped' | 'failed'
  >;

  @IsOptional()
  @IsArray()
  @IsIn(
    [
      'queued',
      'read_source',
      'image_enrichment',
      'analysis',
      'generation',
      'merge',
      'validation',
      'import',
      'completed',
    ],
    { each: true },
  )
  stages?: Array<
    | 'queued'
    | 'read_source'
    | 'image_enrichment'
    | 'analysis'
    | 'generation'
    | 'merge'
    | 'validation'
    | 'import'
    | 'completed'
  >;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

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
