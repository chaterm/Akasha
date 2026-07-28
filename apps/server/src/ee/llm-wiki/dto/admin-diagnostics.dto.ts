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
  Min,
} from 'class-validator';

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
