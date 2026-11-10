import { MODULE_METADATA } from '@nestjs/common/constants';
import { SemanticKnowledgeCompilerRunner } from './adapters/semantic-knowledge-compiler.runner';
import { KNOWLEDGE_COMPILER_RUNNER } from './llm-wiki.constants';
import { LlmWikiModule } from './llm-wiki.module';
import { KnowledgePageMergeProcessor } from './processors/knowledge-page-merge.processor';
import { KnowledgePageMergeReaperService } from './services/knowledge-page-merge-reaper.service';
import { KnowledgeSpaceProcessor } from './processors/knowledge-space.processor';

// This metadata test does not exercise the MCP/collaboration or Space modules.
// Isolate their infrastructure rather than importing ESM-only collaboration
// dependencies through the CommonJS Jest runner.
jest.mock('../../core/mcp/mcp.module', () => ({
  McpModule: class McpModule {},
}));
jest.mock('../../core/space/space.module', () => ({
  SpaceModule: class SpaceModule {},
}));
jest.mock('../../ee/sso/sso.module', () => ({ SsoModule: class SsoModule {} }));

describe('LlmWikiModule', () => {
  it('uses the project-local Akasha runner for compile jobs', () => {
    const providers =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, LlmWikiModule) ?? [];

    expect(providers).toEqual(
      expect.arrayContaining([
        SemanticKnowledgeCompilerRunner,
        KnowledgePageMergeProcessor,
        KnowledgePageMergeReaperService,
        KnowledgeSpaceProcessor,
        expect.objectContaining({
          provide: KNOWLEDGE_COMPILER_RUNNER,
          useExisting: SemanticKnowledgeCompilerRunner,
        }),
      ]),
    );
  });
});
