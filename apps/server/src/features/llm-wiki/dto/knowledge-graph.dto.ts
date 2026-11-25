import { IsString } from 'class-validator';

export class KnowledgeGraphDto {
  @IsString()
  spaceId: string;
}
