import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MAX_GRAPH_NODE_LIMIT } from '../knowledge-graph.constants';

export class KnowledgeGraphDto {
  @IsString()
  spaceId: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_GRAPH_NODE_LIMIT)
  limit?: number;
}
