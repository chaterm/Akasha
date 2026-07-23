import { ArrayNotEmpty, IsArray, IsIn, IsString } from 'class-validator';
import { KnowledgeAdminSpaceAction } from '../types/knowledge-queue.types';

export class AdminKnowledgeSpaceActionDto {
  @IsIn(['retry_compile', 'reindex_access', 'mark_stale', 'rebuild_embeddings'])
  action: KnowledgeAdminSpaceAction;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  spaceIds: string[];
}
