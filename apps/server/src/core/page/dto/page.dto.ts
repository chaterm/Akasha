import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

import { ContentFormat } from './create-page.dto';
import { PagePermissionRole } from '../../../common/helpers/types/permission';

export class PageIdDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;
}

export class SpaceIdDto {
  @IsUUID()
  spaceId: string;
}

export class PageHistoryIdDto {
  @IsUUID()
  historyId: string;
}

export class PageInfoDto extends PageIdDto {
  @IsOptional()
  @IsBoolean()
  includeSpace: boolean;

  @IsOptional()
  @IsBoolean()
  includeContent: boolean;

  @IsOptional()
  @Transform(({ value }) => value?.toLowerCase())
  @IsIn(['json', 'markdown', 'html'])
  format?: ContentFormat;
}

export class PersonalPageSearchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  query: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 10;
}

export class DeletePageDto extends PageIdDto {
  @IsOptional()
  @IsBoolean()
  permanentlyDelete?: boolean;
}

export class AddPagePermissionDto extends PageIdDto {
  @IsEnum(PagePermissionRole)
  role: PagePermissionRole;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  groupIds?: string[];
}

export class RemovePagePermissionDto extends PageIdDto {
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  userIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  groupIds?: string[];
}

export class UpdatePagePermissionRoleDto extends PageIdDto {
  @IsEnum(PagePermissionRole)
  role: PagePermissionRole;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;
}
