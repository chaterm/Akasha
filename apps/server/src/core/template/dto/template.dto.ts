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

/**
 * - all：用户可见的全部模板（管理页默认）
 * - allSpaces：仅"所有空间"模板
 * - space：明确指定到 spaceId 的模板
 * - available：在 spaceId 中可用的模板（所有空间 + 指定到该空间），空间内建页使用
 */
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

/** 可用范围：allSpaces=true 时忽略 spaceIds；否则 spaceIds 至少一个。 */
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

  // 另存为模板：从已有页面复制正文（与 content 二选一）
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
