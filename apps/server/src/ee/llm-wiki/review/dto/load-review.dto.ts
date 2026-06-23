import { IsString } from 'class-validator';

export class LoadReviewDto {
  @IsString()
  spaceId: string;
}
