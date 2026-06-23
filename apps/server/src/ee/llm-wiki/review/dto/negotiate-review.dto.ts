import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class NegotiateReviewDto {
  @IsString()
  spaceId: string;

  @IsObject()
  item: unknown;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  feedback?: string;
}
