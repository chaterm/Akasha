import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class AiModelConfigParametersDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  dimension?: number;

  @IsOptional()
  @IsBoolean()
  supportsMrl?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  topP?: number;

  @IsOptional()
  @IsInt()
  seed?: number;

  @IsOptional()
  @IsIn(['qwen', 'openai'])
  thinkingMode?: 'qwen' | 'openai';

  @IsOptional()
  @IsBoolean()
  thinkingEnabled?: boolean;

  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export class UpdateAiModelConfigDto {
  @IsIn(['openai-compatible'])
  provider: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  model: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  @MaxLength(2000)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiModelConfigParametersDto)
  parameters?: AiModelConfigParametersDto | null;
}

export class TestAiModelConfigDto {
  @IsIn(['openai-compatible'])
  provider: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  model: string;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  @MaxLength(2000)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiModelConfigParametersDto)
  parameters?: AiModelConfigParametersDto;
}
