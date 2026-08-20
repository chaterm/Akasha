import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsEnum,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum KnowledgeQueryType {
  USER = 'user',
  ROBOT = 'robot',
}

export class QueryKnowledgeDto {
  @IsOptional()
  @IsEnum(KnowledgeQueryType)
  type?: KnowledgeQueryType;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  query: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  spaceIds: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(4000, { each: true })
  chatContext?: string[];
}
