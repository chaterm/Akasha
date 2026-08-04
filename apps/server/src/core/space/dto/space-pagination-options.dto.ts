import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from 'class-validator';

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
}
