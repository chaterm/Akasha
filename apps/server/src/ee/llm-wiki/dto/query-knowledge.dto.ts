import {
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class QueryKnowledgeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  query: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  spaceIds: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  chatContext?: string[];
}
