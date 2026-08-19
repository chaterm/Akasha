import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePublicApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  spaceIds: string[];

  @IsOptional()
  @IsString()
  expiresAt?: string;
}
