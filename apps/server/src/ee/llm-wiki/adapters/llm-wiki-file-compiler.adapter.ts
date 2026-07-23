import { Inject, Injectable } from '@nestjs/common';
import { KnowledgeCompilerAdapter } from './knowledge-compiler.adapter';
import {
  CompileSpaceInput,
  CompileSpaceResult,
} from '../types/compiler-artifact.types';
import { LlmWikiCompilerRunner } from './llm-wiki-file-compiler.runner';
import { KNOWLEDGE_COMPILER_RUNNER } from '../llm-wiki.constants';

@Injectable()
export class LlmWikiFileCompilerAdapter implements KnowledgeCompilerAdapter {
  constructor(
    @Inject(KNOWLEDGE_COMPILER_RUNNER)
    private readonly runner: LlmWikiCompilerRunner,
  ) {}

  async compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult> {
    const hasOutOfScopeSource = input.sources.some(
      (source) =>
        source.workspaceId !== input.workspaceId ||
        source.spaceId !== input.spaceId,
    );

    if (hasOutOfScopeSource) {
      throw new Error(
        'compile input contains sources outside workspaceId+spaceId',
      );
    }

    return this.runner.compileSpace(input);
  }
}
