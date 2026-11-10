import { IsIn, IsOptional } from 'class-validator';
import {
  KNOWLEDGE_PAGE_INDEX_MODE_INHERIT,
  KnowledgePageIndexModeChoice,
} from '../types/knowledge-index-mode.types';

export class PagePublishDto {
  // `inherit` clears the page override so the page follows the Space default.
  @IsOptional()
  @IsIn(['compiled', 'original', 'inherit'])
  indexMode?: KnowledgePageIndexModeChoice = KNOWLEDGE_PAGE_INDEX_MODE_INHERIT;
}
