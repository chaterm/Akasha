import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { PageIdDto } from '../../page/dto/page.dto';

export class RecordPageVisitDto extends PageIdDto {}

export class RecentPageVisitsDto {
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 15;
}
