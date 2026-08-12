import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class RestorePageAuthorItemDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  importTaskId: string;

  @IsOptional()
  @IsUUID()
  creatorUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  creatorName?: string;

  @IsOptional()
  @IsUUID()
  lastUpdatedByUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  lastUpdatedByName?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  createdAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  updatedAt?: string;
}

export class RestorePageAuthorsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RestorePageAuthorItemDto)
  items: RestorePageAuthorItemDto[];
}
