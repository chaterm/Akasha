import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsUUID,
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
}
