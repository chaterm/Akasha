import { IsIn } from 'class-validator';
import { KnowledgePageIndexModeChoice } from '../types/knowledge-index-mode.types';

export class PageIndexModeDto {
  @IsIn(['compiled', 'original', 'inherit'])
  indexMode: KnowledgePageIndexModeChoice;
}
