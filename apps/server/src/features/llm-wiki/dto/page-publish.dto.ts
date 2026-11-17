import { IsIn, IsOptional } from 'class-validator';
import {
  KNOWLEDGE_PAGE_INDEX_MODE_INHERIT,
  KnowledgePageIndexModeChoice,
} from '../types/knowledge-index-mode.types';

export class PagePublishDto {
  @IsOptional()
  @IsIn(['compiled', 'original', 'inherit'])
  indexMode?: KnowledgePageIndexModeChoice = KNOWLEDGE_PAGE_INDEX_MODE_INHERIT;
}
