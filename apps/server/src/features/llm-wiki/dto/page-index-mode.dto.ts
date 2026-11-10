import { IsIn } from 'class-validator';
import { KnowledgePageIndexModeChoice } from '../types/knowledge-index-mode.types';

export class PageIndexModeDto {
  // `inherit` clears the page override so the page follows the Space default.
  @IsIn(['compiled', 'original', 'inherit'])
  indexMode: KnowledgePageIndexModeChoice;
}
