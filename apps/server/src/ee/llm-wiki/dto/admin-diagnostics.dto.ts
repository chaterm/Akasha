import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class AdminKnowledgeDiagnosticsDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  spaceIds?: string[];

  @IsOptional()
  @IsArray()
  @IsIn(['not_started', 'queued', 'running', 'succeeded', 'failed'], {
    each: true,
  })
  statuses?: Array<
    'not_started' | 'queued' | 'running' | 'succeeded' | 'failed'
  >;

  @IsOptional()
  @IsArray()
  @IsIn(
    [
      'queued',
      'read_source',
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
