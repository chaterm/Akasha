import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { SpaceRole } from '../../../common/helpers/types/permission';

export class SpacePaginationOptions {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Min(1)
  @Max(5000)
  limit = 20;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  beforeCursor?: string;

  @IsOptional()
  @IsString()
  query: string;

  @IsOptional()
  @IsBoolean()
  adminView: boolean;

  @IsOptional()
  @IsIn([SpaceRole.ADMIN, SpaceRole.WRITER, SpaceRole.READER])
  role?: SpaceRole;

  @IsOptional()
  @IsIn(['public', 'personal', 'created-personal', 'favorites'])
  type?: 'public' | 'personal' | 'created-personal' | 'favorites';

  @IsOptional()
  @IsIn(['default', 'created'])
  personalKind?: 'default' | 'created';

  @IsOptional()
  @IsBoolean()
  sortByType?: boolean;

  @IsOptional()
  @IsString()
  ownerQuery?: string;
}
