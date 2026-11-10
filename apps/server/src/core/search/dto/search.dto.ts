import {
  ArrayMaxSize,
  IsBoolean,
  IsDateString,
  IsIn,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizeLabelName } from '../../label/utils';

const SEARCH_CONTENT_TYPES = ['page', 'attachment'] as const;

export class SearchDTO {
  @IsNotEmpty()
  @IsString()
  query: string;

  @IsOptional()
  @IsString()
  spaceId: string;

  @IsOptional()
  @IsString()
  shareId?: string;

  @IsOptional()
  @IsString()
  creatorId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsUUID('all', { each: true })
  labelIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsString({ each: true })
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map(normalizeLabelName) : value,
  )
  labelNames?: string[];

  @IsOptional()
  @IsBoolean()
  titleOnly?: boolean;

  @IsOptional()
  @IsDateString()
  modifiedFrom?: string;

  @IsOptional()
  @IsDateString()
  modifiedTo?: string;

  @IsOptional()
  @IsIn(SEARCH_CONTENT_TYPES)
  contentType?: (typeof SEARCH_CONTENT_TYPES)[number];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  offset?: number;
}

export class SearchShareDTO extends SearchDTO {
  @IsNotEmpty()
  @IsString()
  shareId: string;

  @IsOptional()
  @IsString()
  spaceId: string;
}

export class SearchSuggestionDTO {
  @IsString()
  query: string;

  @IsOptional()
  @IsBoolean()
  includeUsers?: boolean;

  @IsOptional()
  @IsBoolean()
  includeGroups?: boolean;

  @IsOptional()
  @IsBoolean()
  includePages?: boolean;

  @IsOptional()
  @IsString()
  spaceId?: string;

  @IsOptional()
  @IsNumber()
  limit?: number;
}

/** Pages referenced by a database's document columns, looked up for the current user. */
export class ResolvePagesDTO {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  pageIds: string[];
}
