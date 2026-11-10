import {
  CompileSpaceInput,
  CompileSpaceResult,
} from '../types/compiler-artifact.types';

export interface KnowledgeCompilerAdapter {
  compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult>;
}
