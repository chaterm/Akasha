import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateApiKeyDto {
  @IsString()
  apiKeyId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}
