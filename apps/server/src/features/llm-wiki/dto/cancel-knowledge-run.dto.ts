import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelKnowledgeRunDto {
  @IsOptional()
  @IsString()
  @MaxLength(400)
  reason?: string;
}
