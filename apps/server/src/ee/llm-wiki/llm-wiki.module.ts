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
import { KnowledgeQualityService } from './services/knowledge-quality.service';
import { KnowledgeGraphService } from './services/knowledge-graph.service';
import { AiKnowledgeChatService } from './services/ai-knowledge-chat.service';
import { ConfiguredKnowledgeAnswerProvider } from './services/knowledge-answer-provider.service';
import { LlmWikiProcessor } from './processors/llm-wiki.processor';
import {
  KNOWLEDGE_ANSWER_PROVIDER,
  KNOWLEDGE_COMPILER_ADAPTER,
  KNOWLEDGE_COMPILER_RUNNER,
} from './llm-wiki.constants';
import { LlmWikiController } from './llm-wiki.controller';
import { NoopAuditModule } from '../../integrations/audit/audit.module';
import { LlmWikiFileCompilerAdapter } from './adapters/llm-wiki-file-compiler.adapter';
import { DocmostKnowledgeCompilerRunner } from './adapters/docmost-knowledge-compiler.runner';
import { ReviewModule } from './review/review.module';
import { KnowledgeVectorIndexService } from './services/knowledge-vector-index.service';

@Module({
  imports: [NoopAuditModule, ReviewModule],
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
    ConfiguredKnowledgeEmbeddingProvider,
    KnowledgeVectorIndexService,
    ConfiguredKnowledgeAnswerProvider,
    {
      provide: KNOWLEDGE_ANSWER_PROVIDER,
      useExisting: ConfiguredKnowledgeAnswerProvider,
    },
    DocmostKnowledgeCompilerRunner,
    {
      provide: KNOWLEDGE_COMPILER_RUNNER,
      useExisting: DocmostKnowledgeCompilerRunner,
    },
    LlmWikiFileCompilerAdapter,
    {
      provide: KNOWLEDGE_COMPILER_ADAPTER,
      useExisting: LlmWikiFileCompilerAdapter,
    },
    LlmWikiProcessor,
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
    KnowledgeQualityService,
    KnowledgeGraphService,
    AiKnowledgeChatService,
  ],
})
export class LlmWikiModule {}
