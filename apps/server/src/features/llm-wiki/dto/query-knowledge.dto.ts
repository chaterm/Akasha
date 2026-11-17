import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizeLabelName } from '../../../core/label/utils';

export enum KnowledgeQueryType {
  USER = 'user',
  ROBOT = 'robot',
}

export class QueryKnowledgeDto {
  @IsOptional()
  @IsBoolean()
  generalKnowledgeEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  rawResultsOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  queryRewriteEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  attachments?: boolean;

  @IsOptional()
  @IsBoolean()
  includeCitations?: boolean;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(2)
  scoreThreshold?: number;

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
  @ArrayNotEmpty()
  @ArrayMaxSize(25)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((name) =>
          typeof name === 'string' ? normalizeLabelName(name) : name,
        )
      : value,
  )
  @ArrayUnique()
  @MaxLength(100, { each: true })
  @Matches(/^[\p{L}\p{N}_-][\p{L}\p{N}_~-]*$/u, { each: true })
  labels?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(4000, { each: true })
  chatContext?: string[];
}
