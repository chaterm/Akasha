import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';

export type TemplateScope = 'all' | 'allSpaces' | 'space' | 'available';

export class ListTemplatesDto extends PaginationOptions {
  @IsOptional()
  @IsIn(['all', 'allSpaces', 'space', 'available'])
  scope?: TemplateScope;

  @ValidateIf((o) => o.scope === 'space' || o.scope === 'available')
  @IsUUID()
  spaceId?: string;
}

export class TemplateIdDto {
  @IsUUID()
  templateId: string;
}

class TemplateAvailabilityDto {
  @IsOptional()
  @IsBoolean()
  allSpaces?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  spaceIds?: string[];
}

export class CreateTemplateDto extends TemplateAvailabilityDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  icon?: string;

  @IsOptional()
  @IsObject()
  content?: Record<string, any>;

  @IsOptional()
  @IsUUID()
  sourcePageId?: string;
}

export class UpdateTemplateDto extends TemplateAvailabilityDto {
  @IsUUID()
  templateId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  icon?: string | null;

  @IsOptional()
  @IsObject()
  content?: Record<string, any>;
}

export class UseTemplateDto extends TemplateIdDto {
  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsUUID()
  parentPageId?: string;
}
