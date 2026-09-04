import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsEnum,
  IsNumber,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';

export enum KnowledgeQueryType {
  USER = 'user',
  ROBOT = 'robot',
}

export class QueryKnowledgeDto {
  /** Allow fallback to general knowledge for this iself query only. */
  @IsOptional()
  @IsBoolean()
  generalKnowledgeEnabled?: boolean;

  /** Return signed URLs for attachments belonging to cited pages. */
  @IsOptional()
  @IsBoolean()
  attachments?: boolean;

  /** Return citation materials, including signed attachment download URLs. */
  @IsOptional()
  @IsBoolean()
  includeCitations?: boolean;

  /**
   * Maximum semantic cosine distance accepted during recall. Lower values are
   * stricter; omitted requests keep the default retrieval threshold.
   */
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
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(4000, { each: true })
  chatContext?: string[];
}
