import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Feature-specific tuning persisted as JSON. Kept intentionally small: only the
// knobs the admin UI exposes for OpenAI-compatible providers.
export class AiModelConfigParametersDto {
  // Embedding: vector dimensions.
  @IsOptional()
  @IsInt()
  @Min(1)
  dimension?: number;

  // Embedding: Matryoshka representation support.
  @IsOptional()
  @IsBoolean()
  supportsMrl?: boolean;
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

  // Omit to keep the stored key unchanged. Empty string clears it. Any other
  // value replaces it (encrypted before storage).
  @IsOptional()
  @IsString()
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiModelConfigParametersDto)
  parameters?: AiModelConfigParametersDto;
}
