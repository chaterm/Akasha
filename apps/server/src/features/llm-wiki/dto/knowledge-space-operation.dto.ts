import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { KnowledgeIndexMode } from '../types/knowledge-index-mode.types';

export class KnowledgeSpaceOperationDto {
  @IsString()
  @MaxLength(255)
  confirmationSpaceName: string;

  @IsOptional()
  @IsIn(['compiled', 'original'])
  forceIndexMode?: KnowledgeIndexMode;
}
