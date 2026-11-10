import { ArrayMaxSize, ArrayMinSize, IsArray, IsString } from 'class-validator';

export class AdminKnowledgeRetryPagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  pageIds: string[];
}
