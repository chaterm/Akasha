import { MODULE_METADATA } from '@nestjs/common/constants';
import { SemanticKnowledgeCompilerRunner } from './adapters/semantic-knowledge-compiler.runner';
import { KNOWLEDGE_COMPILER_RUNNER } from './llm-wiki.constants';
import { LlmWikiModule } from './llm-wiki.module';

jest.mock('./review/review.module', () => ({ ReviewModule: class {} }));

describe('LlmWikiModule', () => {
  it('uses the project-local Akasha runner for compile jobs', () => {
    const providers =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, LlmWikiModule) ?? [];

    expect(providers).toEqual(
      expect.arrayContaining([
        SemanticKnowledgeCompilerRunner,
        expect.objectContaining({
          provide: KNOWLEDGE_COMPILER_RUNNER,
          useExisting: SemanticKnowledgeCompilerRunner,
        }),
      ]),
    );
  });
});
