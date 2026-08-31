import { Module } from '@nestjs/common';
import { SpaceAuthorizationService } from '../../core/space/services/space-authorization.service';
import { KnowledgeSourceAuthorizationService } from './services/knowledge-source-authorization.service';
import { KnowledgeSourceExporterService } from './services/knowledge-source-exporter.service';
import { KnowledgeArtifactValidatorService } from './services/knowledge-artifact-validator.service';
import { KnowledgeImportService } from './services/knowledge-import.service';
import { KnowledgeAccessIndexerService } from './services/knowledge-access-indexer.service';
import { KnowledgeAccessRepairService } from './services/knowledge-access-repair.service';
import { KnowledgeRetrievalService } from './services/knowledge-retrieval.service';
import { ConfiguredKnowledgeEmbeddingProvider } from './services/knowledge-embedding-provider.service';
import { KnowledgeRetrievalRankerService } from './services/knowledge-retrieval-ranker.service';
import { KnowledgeContextPackService } from './services/knowledge-context-pack.service';
import { KnowledgeCitationResolverService } from './services/knowledge-citation-resolver.service';
import { KnowledgeDiagnosticsService } from './services/knowledge-diagnostics.service';
import { KnowledgeGraphService } from './services/knowledge-graph.service';
import { AiKnowledgeChatService } from './services/ai-knowledge-chat.service';
import { KnowledgeCitationImageResolverService } from './services/knowledge-citation-image-resolver.service';
import { KnowledgeCitationImageRepo } from '../../database/repos/llm-wiki/knowledge-citation-image.repo';
import { ConfiguredKnowledgeAnswerProvider } from './services/knowledge-answer-provider.service';
import { KnowledgeTextProcessor } from './processors/knowledge-text.processor';
import { KnowledgeImageProcessor } from './processors/knowledge-image.processor';
import {
  KNOWLEDGE_ANSWER_PROVIDER,
  KNOWLEDGE_COMPILER_ADAPTER,
  KNOWLEDGE_COMPILER_LLM_PROVIDER,
  KNOWLEDGE_COMPILER_RUNNER,
  KNOWLEDGE_IMAGE_UNDERSTANDING_PROVIDER,
} from './llm-wiki.constants';
import { LlmWikiController } from './llm-wiki.controller';
import { NoopAuditModule } from '../../integrations/audit/audit.module';
import { LlmWikiFileCompilerAdapter } from './adapters/llm-wiki-file-compiler.adapter';
import { SemanticKnowledgeCompilerRunner } from './adapters/semantic-knowledge-compiler.runner';
import { ReviewModule } from './review/review.module';
import { KnowledgeVectorIndexService } from './services/knowledge-vector-index.service';
import { ConfiguredKnowledgeCompilerLlmProvider } from './compiler/knowledge-compiler-llm.provider';
import { KnowledgeArtifactMaterializerService } from './services/knowledge-artifact-materializer.service';
import { KnowledgeArtifactCatalogService } from './services/knowledge-artifact-catalog.service';
import { KnowledgeSpaceCompilationService } from './services/knowledge-space-compilation.service';
import { KnowledgeLinkResolverService } from './services/knowledge-link-resolver.service';
import { KnowledgeSpaceFinalizerService } from './services/knowledge-space-finalizer.service';
import { KnowledgeSourceRetirementService } from './services/knowledge-source-retirement.service';
import { ConfiguredKnowledgeImageUnderstandingProvider } from './services/knowledge-image-understanding-provider.service';
import { KnowledgeImageEnrichmentService } from './services/knowledge-image-enrichment.service';
import { KnowledgeSpaceResetService } from './services/knowledge-space-reset.service';
import { KnowledgeTextJobHandler } from './services/knowledge-text-job.handler';
import { KnowledgePageCompilationService } from './services/knowledge-page-compilation.service';
import { KnowledgeSpaceRunnerService } from './services/knowledge-space-runner.service';
import { KnowledgeSpaceProcessor } from './processors/knowledge-space.processor';
import { KnowledgeRunReaperService } from './services/knowledge-run-reaper.service';
import { KnowledgeImageReaperService } from './services/knowledge-image-reaper.service';
import { KnowledgeQualityService } from './services/knowledge-quality.service';
import { AiModelConfigModule } from './services/ai-model-config.module';
import { ApiKeyModule } from '../api-key/api-key.module';
import { TokenModule } from '../../core/auth/token.module';
import { McpModule } from '../../core/mcp/mcp.module';
import { SpaceModule } from '../../core/space/space.module';
import { KnowledgeMcpToolExtension } from './services/knowledge-mcp-tool.extension';

@Module({
  imports: [
    NoopAuditModule,
    AiModelConfigModule,
    ReviewModule,
    ApiKeyModule,
    TokenModule,
    McpModule,
    SpaceModule,
  ],
  controllers: [LlmWikiController],
  providers: [
    SpaceAuthorizationService,
    KnowledgeSourceAuthorizationService,
    KnowledgeSourceExporterService,
    KnowledgeArtifactValidatorService,
    KnowledgeImportService,
    KnowledgeAccessIndexerService,
    KnowledgeAccessRepairService,
    KnowledgeRetrievalService,
    KnowledgeRetrievalRankerService,
    KnowledgeContextPackService,
    KnowledgeCitationResolverService,
    KnowledgeDiagnosticsService,
    KnowledgeQualityService,
    KnowledgeGraphService,
    AiKnowledgeChatService,
    KnowledgeCitationImageResolverService,
    KnowledgeCitationImageRepo,
    ConfiguredKnowledgeEmbeddingProvider,
    KnowledgeVectorIndexService,
    ConfiguredKnowledgeAnswerProvider,
    ConfiguredKnowledgeCompilerLlmProvider,
    ConfiguredKnowledgeImageUnderstandingProvider,
    KnowledgeImageEnrichmentService,
    KnowledgeArtifactMaterializerService,
    KnowledgeArtifactCatalogService,
    KnowledgeSpaceCompilationService,
    KnowledgeSpaceResetService,
    KnowledgePageCompilationService,
    KnowledgeSpaceRunnerService,
    KnowledgeRunReaperService,
    KnowledgeImageReaperService,
    KnowledgeTextJobHandler,
    KnowledgeLinkResolverService,
    KnowledgeSpaceFinalizerService,
    KnowledgeSourceRetirementService,
    {
      provide: KNOWLEDGE_ANSWER_PROVIDER,
      useExisting: ConfiguredKnowledgeAnswerProvider,
    },
    {
      provide: KNOWLEDGE_COMPILER_LLM_PROVIDER,
      useExisting: ConfiguredKnowledgeCompilerLlmProvider,
    },
    {
      provide: KNOWLEDGE_IMAGE_UNDERSTANDING_PROVIDER,
      useExisting: ConfiguredKnowledgeImageUnderstandingProvider,
    },
    SemanticKnowledgeCompilerRunner,
    {
      provide: KNOWLEDGE_COMPILER_RUNNER,
      useExisting: SemanticKnowledgeCompilerRunner,
    },
    LlmWikiFileCompilerAdapter,
    {
      provide: KNOWLEDGE_COMPILER_ADAPTER,
      useExisting: LlmWikiFileCompilerAdapter,
    },
    KnowledgeTextProcessor,
    KnowledgeImageProcessor,
    KnowledgeSpaceProcessor,
    KnowledgeMcpToolExtension,
  ],
  exports: [
    KnowledgeSourceAuthorizationService,
    KnowledgeSourceExporterService,
    KnowledgeArtifactValidatorService,
    KnowledgeImportService,
    KnowledgeAccessIndexerService,
    KnowledgeAccessRepairService,
    KnowledgeRetrievalService,
    KnowledgeContextPackService,
    KnowledgeCitationResolverService,
    KnowledgeDiagnosticsService,
    KnowledgeGraphService,
    AiKnowledgeChatService,
  ],
})
export class LlmWikiModule {}
