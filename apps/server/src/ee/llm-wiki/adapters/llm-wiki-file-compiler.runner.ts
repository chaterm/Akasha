import {
  CompileSpaceInput,
  CompileSpaceResult,
} from '../types/compiler-artifact.types';

export interface LlmWikiCompilerRunner {
  compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult>;
}

export class UnconfiguredLlmWikiCompilerRunner implements LlmWikiCompilerRunner {
  async compileSpace(_input: CompileSpaceInput): Promise<CompileSpaceResult> {
    throw new Error('llm-wiki compiler runner is not configured');
  }
}
