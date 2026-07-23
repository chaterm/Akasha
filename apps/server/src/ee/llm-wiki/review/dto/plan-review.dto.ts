import { IsString } from 'class-validator';

export class PlanReviewDto {
  @IsString()
  spaceId: string;
}
