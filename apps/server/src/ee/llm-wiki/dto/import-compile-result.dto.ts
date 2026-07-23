import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CompiledKnowledgeArtifact } from '../types/compiler-artifact.types';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';

export class ImportCompileResultDto {
  @IsString()
  @IsNotEmpty()
  spaceId: string;

  @IsOptional()
  @IsString()
  compilerVersion?: string;

  @IsOptional()
  @IsString()
  promptVersion?: string;

  @IsArray()
  sources: KnowledgeSourceSnapshot[];

  @IsArray()
  artifacts: CompiledKnowledgeArtifact[];
}
