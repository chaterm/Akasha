import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { SpaceRole } from '../../../common/helpers/types/permission';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const trimItems = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim()),
        ),
      ]
    : value;

export class ListGroupDto {
  @IsOptional()
  @IsString()
  @Transform(trim)
  query?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 100;
}

export class CreateGroupDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(100, { each: true })
  @Transform(trimItems)
  groupNames: string[];
}

export class UpdateGroupDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  oldGroupName: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  newGroupName: string;
}

export class DeleteGroupDto extends CreateGroupDto {}

export class ListUserGroupDto {
  @IsEmail()
  @Transform(trim)
  email: string;
}

export class GroupNameDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  groupName: string;
}

export class ListGroupUserDto extends GroupNameDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 500;
}

export class GroupMembersDto extends ListGroupUserDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsEmail({}, { each: true })
  @Transform(trimItems)
  emails: string[];
}

export class GroupSpacePermissionDto extends GroupNameDto {
  @IsString()
  @IsNotEmpty()
  @Transform(trim)
  spaceSlug: string;
}

export class CreateGroupSpacePermissionDto extends GroupSpacePermissionDto {
  @IsEnum(SpaceRole)
  role: SpaceRole;
}

export class UpdateGroupSpacePermissionDto extends CreateGroupSpacePermissionDto {}

export class DeleteUserDto {
  @IsEmail()
  @Transform(trim)
  email: string;
}
