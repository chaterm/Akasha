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
  /** Allow fallback to general knowledge for this iself query only. */
  @IsOptional()
  @IsBoolean()
  generalKnowledgeEnabled?: boolean;

  /**
   * Skip the answer-generation LLM and return raw retrieval results directly
   * (snippets/sources/citations/evidence) for lower latency. Query rewrite
   * still runs unless disabled via `queryRewriteEnabled`. When enabled, no
   * general-knowledge fallback is attempted regardless of
   * `generalKnowledgeEnabled`. Defaults to false (full answer generation).
   */
  @IsOptional()
  @IsBoolean()
  rawResultsOnly?: boolean;

  /**
   * Whether to run the LLM query-rewrite step, which merges `chatContext` into
   * a standalone retrieval query. Defaults to true. Set false to skip rewrite
   * and retrieve with the original query verbatim.
   */
  @IsOptional()
  @IsBoolean()
  queryRewriteEnabled?: boolean;

  /**
   * Return signed URLs for non-image attachments that live inside the final
   * direct-hit blocks of this retrieval, up to 5 items.
   */
  @IsOptional()
  @IsBoolean()
  attachments?: boolean;

  /** Return citation materials. Does not control top-level attachments. */
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

  /**
   * Restrict retrieval to source pages that have at least one of these labels.
   * Multiple labels use OR semantics.
   */
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
