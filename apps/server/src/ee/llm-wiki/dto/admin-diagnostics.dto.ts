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
