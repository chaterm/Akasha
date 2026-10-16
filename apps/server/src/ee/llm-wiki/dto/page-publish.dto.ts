import { IsIn, IsOptional } from 'class-validator';
import {
  DEFAULT_KNOWLEDGE_INDEX_MODE,
  KnowledgeIndexMode,
} from '../types/knowledge-index-mode.types';

export class PagePublishDto {
  @IsOptional()
  @IsIn(['compiled', 'original'])
  indexMode?: KnowledgeIndexMode = DEFAULT_KNOWLEDGE_INDEX_MODE;
}
