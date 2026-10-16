import { Inject, Injectable, Optional } from '@nestjs/common';
import { KnowledgeCompilerAdapter } from './knowledge-compiler.adapter';
import {
  CompileSpaceInput,
  CompileSpaceResult,
} from '../types/compiler-artifact.types';
import { LlmWikiCompilerRunner } from './llm-wiki-file-compiler.runner';
import { KNOWLEDGE_COMPILER_RUNNER } from '../llm-wiki.constants';
import { OriginalDocumentCompilerRunner } from './original-document-compiler.runner';

@Injectable()
export class LlmWikiFileCompilerAdapter implements KnowledgeCompilerAdapter {
  constructor(
    @Inject(KNOWLEDGE_COMPILER_RUNNER)
    private readonly runner: LlmWikiCompilerRunner,
    @Optional()
    private readonly originalRunner?: OriginalDocumentCompilerRunner,
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

    return (
      input.indexMode === 'original' && this.originalRunner
        ? this.originalRunner
        : this.runner
    ).compileSpace(input);
  }
}
