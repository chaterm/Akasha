import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { JsonValue } from '@akasha/db/types/db';
import {
  KNOWLEDGE_COMPILER_LLM_PROVIDER,
} from '../llm-wiki.constants';
import {
  KnowledgeCompilerLlmProvider,
} from '../compiler/knowledge-compiler-llm.provider';
import {
  buildSemanticAnalysisMessages,
  buildSemanticGenerationMessages,
} from '../compiler/semantic-compiler.prompts';
import {
  SemanticAnalysis,
  semanticAnalysisSchema,
  SemanticGeneratedArtifact,
} from '../compiler/semantic-compiler.schema';
import {
  CompiledKnowledgeArtifact,
  CompileDiagnostic,
  CompileSpaceInput,
  CompileSpaceResult,
} from '../types/compiler-artifact.types';
import { KnowledgeSourceRef } from '../types/knowledge.types';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { LlmWikiCompilerRunner } from './llm-wiki-file-compiler.runner';

@Injectable()
export class SemanticKnowledgeCompilerRunner implements LlmWikiCompilerRunner {
  constructor(
    @Inject(KNOWLEDGE_COMPILER_LLM_PROVIDER)
    private readonly provider: KnowledgeCompilerLlmProvider,
    private readonly compilationRepo: KnowledgeCompilationRepo,
  ) {}

  async compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult> {
    if (input.sources.length !== 1) {
      throw new Error('semantic compilation requires exactly one source page');
    }
    const source = input.sources[0];
    if (!source.text.trim()) {
      throw new Error('semantic compilation cannot compile an empty source page');
    }

    const compilerRunId = `${input.workspaceId}:${input.spaceId}:${this.now().toISOString()}`;
    const compileTaskId = `akasha-page:${source.sourcePageId}`;
    const warnings: CompileDiagnostic[] = [];

    await this.compilationRepo.updateStage({
      workspaceId: input.workspaceId,
      sourcePageId: source.sourcePageId,
      stage: 'analysis',
    });
    const analysis = await this.loadOrAnalyze(input, source);

    await this.compilationRepo.updateStage({
      workspaceId: input.workspaceId,
      sourcePageId: source.sourcePageId,
      stage: 'generation',
    });
    const generation = await this.provider.generate(
      buildSemanticGenerationMessages({
        sourcePageId: source.sourcePageId,
        sourceTitle: source.title,
        sourceText: source.text,
        analysis,
        purpose: input.purpose,
        schema: input.schema,
        catalog: input.catalog,
      }),
    );

    const summaries = generation.artifacts.filter(
      (artifact) => artifact.kind === 'source_summary',
    );
    if (summaries.length !== 1) {
      throw new Error('generation must contain exactly one source_summary');
    }

    const normalizedDrafts = generation.artifacts.map((artifact) => ({
      ...artifact,
      canonicalKey:
        artifact.kind === 'source_summary'
          ? source.sourcePageId
          : normalizeCanonicalKey(artifact.canonicalKey),
    }));
    assertUniqueArtifacts(normalizedDrafts);
    const idByKey = new Map(
      normalizedDrafts.map((artifact) => [
        artifactLookupKey(artifact.kind, artifact.canonicalKey),
        stableArtifactId(input, artifact.kind, artifact.canonicalKey),
      ]),
    );

    const artifacts = normalizedDrafts.map((artifact) =>
      toCompiledArtifact({
        input,
        source,
        artifact,
        compilerRunId,
        compileTaskId,
        idByKey,
        warnings,
      }),
    );
    return {
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      sources: [toSourceRef(source)],
      compilerVersion: input.compilerVersion,
      promptVersion: input.promptVersion,
      compilerRunId,
      artifacts,
      diagnostics: { warnings, errors: [] },
    };
  }

  protected now(): Date {
    return new Date();
  }

  private async loadOrAnalyze(
    input: CompileSpaceInput,
    source: KnowledgeSourceSnapshot,
  ): Promise<SemanticAnalysis> {
    const cacheKey = {
      workspaceId: input.workspaceId,
      sourcePageId: source.sourcePageId,
      sourceContentHash: source.contentHash,
      compilerVersion: input.compilerVersion,
      promptVersion: input.promptVersion,
    };
    const cached = await this.compilationRepo.findAnalysis(cacheKey);
    const parsedCache = semanticAnalysisSchema.safeParse(cached);
    if (parsedCache.success) return parsedCache.data;

    const analysis = await this.provider.analyze(
      buildSemanticAnalysisMessages({
        sourceTitle: source.title,
        sourceText: source.text,
        purpose: input.purpose,
        schema: input.schema,
        catalog: input.catalog,
      }),
    );
    await this.compilationRepo.saveAnalysis({
      ...cacheKey,
      spaceId: input.spaceId,
      sourceVersion: source.sourceVersion,
      analysis: analysis as unknown as JsonValue,
    });
    return analysis;
  }
}

function toCompiledArtifact(input: {
  input: CompileSpaceInput;
  source: KnowledgeSourceSnapshot;
  artifact: SemanticGeneratedArtifact;
  compilerRunId: string;
  compileTaskId: string;
  idByKey: Map<string, string>;
  warnings: CompileDiagnostic[];
}): CompiledKnowledgeArtifact {
  const artifactId = stableArtifactId(
    input.input,
    input.artifact.kind,
    input.artifact.canonicalKey,
  );
  const sourceRef = toSourceRef(input.source);
  const claims = input.artifact.claims.map((claim) => ({
    text: claim.text,
    confidence: claim.confidence ?? null,
    inputSourceRefs: [
      sourceRefForEvidence(
        input.source,
        claim.evidenceQuote,
        input.warnings,
      ),
    ],
  }));
  const chunkDrafts = claims.length
    ? claims.map((claim, index) => ({
        text: claim.text,
        claimIndex: index,
        inputSourceRefs: claim.inputSourceRefs,
      }))
    : [{ text: input.artifact.markdown, claimIndex: null, inputSourceRefs: [sourceRef] }];
  const chunks = chunkDrafts.map((chunk, index) => ({
    ...chunk,
    contentHash: sha256(chunk.text),
    stableKey: sha256(`${artifactId}:chunk:${index}:${chunk.text}`),
    parentStableKey: null,
    chunkRole: 'standalone' as const,
    retrievalChannel: 'evidence' as const,
    headingPath: [input.artifact.title],
    embeddingText: `${input.artifact.title}\n${chunk.text}`,
  }));
  const links = input.artifact.links.map((link) => {
    const lookupKey = artifactLookupKey(
      link.targetKind,
      normalizeCanonicalKey(link.targetCanonicalKey),
    );
    const generatedTarget = input.idByKey.get(lookupKey);
    const toKnowledgePageId =
      generatedTarget ??
      stableArtifactId(
        input.input,
        link.targetKind,
        normalizeCanonicalKey(link.targetCanonicalKey),
      );
    return {
      linkType: link.relation,
      linkText: link.targetCanonicalKey,
      targetSpaceId: input.input.spaceId,
      toKnowledgePageId,
      isOpaque: false,
      isDangling: !generatedTarget,
      inputSourceRefs: [
        sourceRefForEvidence(
          input.source,
          link.evidenceQuote,
          input.warnings,
        ),
      ],
    };
  });

  return {
    artifactId,
    artifactKind: input.artifact.kind,
    canonicalKey: input.artifact.canonicalKey,
    workspaceId: input.input.workspaceId,
    spaceId: input.input.spaceId,
    title: input.artifact.title,
    contentMarkdown: input.artifact.markdown,
    sourcePageIds: [input.source.sourcePageId],
    compilerVersion: input.input.compilerVersion,
    promptVersion: input.input.promptVersion,
    compilerRunId: input.compilerRunId,
    compileTaskId: input.compileTaskId,
    inputSourceRefs: [sourceRef],
    claims,
    chunks,
    links,
    graphEdges: links
      .filter((link) => !link.isDangling)
      .map((link) => ({
        toKnowledgePageId: link.toKnowledgePageId,
        relation: link.linkType,
        inputSourceRefs: link.inputSourceRefs,
      })),
    rawArtifactKey: `${input.artifact.kind}:${input.artifact.canonicalKey}`,
  };
}

function sourceRefForEvidence(
  source: KnowledgeSourceSnapshot,
  evidenceQuote: string | undefined,
  warnings: CompileDiagnostic[],
): KnowledgeSourceRef {
  const base = toSourceRef(source);
  if (!evidenceQuote) return base;
  const startOffset = source.text.indexOf(evidenceQuote);
  if (startOffset < 0) {
    warnings.push({
      code: 'evidence_quote_not_found',
      message: 'Generated evidence quote was not found in the source snapshot.',
      sourcePageId: source.sourcePageId,
    });
    return base;
  }
  return {
    ...base,
    sourceRange: {
      startOffset,
      endOffset: startOffset + evidenceQuote.length,
    },
    quoteHash: `sha256:${sha256(evidenceQuote)}`,
  };
}

function toSourceRef(source: KnowledgeSourceSnapshot): KnowledgeSourceRef {
  return {
    workspaceId: source.workspaceId,
    spaceId: source.spaceId,
    sourcePageId: source.sourcePageId,
    sourceVersion: source.sourceVersion,
    contentHash: source.contentHash,
  };
}

function normalizeCanonicalKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function artifactLookupKey(kind: string, canonicalKey: string): string {
  return `${kind}:${canonicalKey}`;
}

function stableArtifactId(
  input: Pick<CompileSpaceInput, 'workspaceId' | 'spaceId'>,
  kind: string,
  canonicalKey: string,
): string {
  return stableUuid(
    `${input.workspaceId}:${input.spaceId}:${kind}:${canonicalKey}`,
  );
}

function stableUuid(value: string): string {
  const hash = sha256(value);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) +
      hash.slice(18, 20),
    hash.slice(20, 32),
  ].join('-');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertUniqueArtifacts(
  artifacts: Array<Pick<SemanticGeneratedArtifact, 'kind' | 'canonicalKey'>>,
): void {
  const keys = artifacts.map((artifact) =>
    artifactLookupKey(artifact.kind, artifact.canonicalKey),
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error('generation contains duplicate canonical artifacts');
  }
}
