import {
  CompileSpaceInput,
  CompileSpaceResult,
} from '../types/compiler-artifact.types';

export interface LlmWikiCompilerRunner {
  compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult>;
}
