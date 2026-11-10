import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { KnowledgeAdminSpaceAction } from '../types/knowledge-queue.types';

export class AdminKnowledgeSpaceActionDto {
  @IsIn(['retry_compile', 'reindex_access', 'mark_stale', 'rebuild_embeddings'])
  action: KnowledgeAdminSpaceAction;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  spaceIds: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  embeddingConcurrency?: number;
}
