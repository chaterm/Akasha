import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { JsonValue } from '@akasha/db/types/db';
import { KNOWLEDGE_COMPILER_LLM_PROVIDER } from '../llm-wiki.constants';
import { KnowledgeCompilerLlmProvider } from '../compiler/knowledge-compiler-llm.provider';
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
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';

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
      throw new Error(
        'semantic compilation cannot compile an empty source page',
      );
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
      {
        canonicalKey: source.sourcePageId,
        title: source.title,
        markdown: source.text,
      },
    );
    if (generation.compilerRecovery) {
      warnings.push({
        code:
          generation.compilerRecovery === 'source_summary_fallback'
            ? 'compiler_source_summary_fallback'
            : 'compiler_output_repaired',
        message:
          generation.compilerRecovery === 'source_summary_fallback'
            ? 'The compiler published a deterministic source summary after structured generation could not be repaired.'
            : 'The compiler normalized or repaired the model output before validation.',
        sourcePageId: source.sourcePageId,
      });
    }

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
    const idByKey = new Map<string, string>();
    for (const entry of input.catalog ?? []) {
      if (!entry.artifactId) continue;
      idByKey.set(
        artifactLookupKey(
          entry.artifactKind,
          normalizeCanonicalKey(entry.canonicalKey),
        ),
        entry.artifactId,
      );
    }
    for (const artifact of normalizedDrafts) {
      idByKey.set(
        artifactLookupKey(artifact.kind, artifact.canonicalKey),
        stableArtifactId(input, artifact.kind, artifact.canonicalKey),
      );
    }

    const compiledArtifacts = normalizedDrafts.map((artifact) =>
      toCompiledArtifact({
        input,
        source,
        artifact,
        compilerRunId,
        compileTaskId,
        idByKey,
        warnings,
        rawFallback: generation.compilerRecovery === 'source_summary_fallback',
      }),
    );
    const artifacts = enrichArtifactRelationships({
      artifacts: compiledArtifacts,
      analysis,
      input,
      source,
      warnings,
    });
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
  rawFallback: boolean;
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
      sourceRefForEvidence(input.source, claim.evidenceQuote, input.warnings),
    ],
  }));
  const structuralParents = chunkKnowledgeSource({
    pageTitle: input.artifact.title,
    text: input.artifact.markdown,
  });
  const parentSections = structuralParents.map((parent) => ({
    stableKey: parent.stableKey,
    headingPath: parent.headingPath,
    text: parent.text,
    contentHash: parent.quoteHash,
    startOffset: parent.startOffset,
    endOffset: parent.endOffset,
    inputSourceRefs: [sourceRef],
  }));
  const chunks = structuralParents.flatMap((parent) =>
    parent.children.map((child) => ({
      text: child.text,
      claimIndex: null,
      inputSourceRefs: [sourceRef],
      contentHash: child.quoteHash,
      stableKey: child.stableKey,
      parentStableKey: parent.stableKey,
      chunkRole: 'child' as const,
      retrievalChannel: 'evidence' as const,
      headingPath: parent.headingPath,
      startOffset: child.startOffset,
      endOffset: child.endOffset,
      embeddingText: child.embeddingText,
    })),
  );
  const links = input.artifact.links.map((link) => {
    const lookupKey = artifactLookupKey(
      link.targetKind,
      normalizeCanonicalKey(link.targetCanonicalKey),
    );
    const generatedTarget = input.idByKey.get(lookupKey);
    return {
      linkType: link.relation,
      linkText: link.targetCanonicalKey,
      targetSpaceId: input.input.spaceId,
      targetArtifactKind: link.targetKind,
      targetCanonicalKey: normalizeCanonicalKey(link.targetCanonicalKey),
      toKnowledgePageId: generatedTarget,
      isOpaque: false,
      isDangling: !generatedTarget,
      inputSourceRefs: [
        sourceRefForEvidence(input.source, link.evidenceQuote, input.warnings),
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
    generationMode: input.rawFallback ? 'raw_fallback' : 'semantic',
    compilerRunId: input.compilerRunId,
    compileTaskId: input.compileTaskId,
    inputSourceRefs: [sourceRef],
    parentSections,
    claims,
    chunks,
    links,
    graphEdges: [],
    rawArtifactKey: `${input.artifact.kind}:${input.artifact.canonicalKey}`,
  };
}

type RelationshipTarget = {
  artifactId: string;
  artifactKind: NonNullable<CompiledKnowledgeArtifact['artifactKind']>;
  canonicalKey: string;
  title: string;
  local: boolean;
};

function enrichArtifactRelationships(input: {
  artifacts: CompiledKnowledgeArtifact[];
  analysis: SemanticAnalysis;
  input: CompileSpaceInput;
  source: KnowledgeSourceSnapshot;
  warnings: CompileDiagnostic[];
}): CompiledKnowledgeArtifact[] {
  const sourceRef = toSourceRef(input.source);
  const targets = relationshipTargets(input.artifacts, input.input.catalog);
  const targetsByCanonicalKey = groupByCanonicalKey(targets);
  const localTargets = targets.filter((target) => target.local);
  const summary = localTargets.find(
    (target) => target.artifactKind === 'source_summary',
  );
  const semanticEdgesByArtifactId = new Map<
    string,
    NonNullable<CompiledKnowledgeArtifact['graphEdges']>
  >();

  for (const relation of input.analysis.relations) {
    const from = uniqueCanonicalTarget(
      targetsByCanonicalKey,
      relation.fromCanonicalKey,
    );
    const to = uniqueCanonicalTarget(
      targetsByCanonicalKey,
      relation.toCanonicalKey,
    );
    if (!from?.local || !to || from.artifactId === to.artifactId) continue;

    const edges = semanticEdgesByArtifactId.get(from.artifactId) ?? [];
    if (
      edges.some(
        (edge) =>
          edge.toKnowledgePageId === to.artifactId &&
          edge.relation === relation.relation,
      )
    ) {
      continue;
    }
    edges.push({
      toKnowledgePageId: to.artifactId,
      relation: relation.relation,
      inputSourceRefs: [
        sourceRefForEvidence(
          input.source,
          relation.evidenceQuote,
          input.warnings,
        ),
      ],
    });
    semanticEdgesByArtifactId.set(from.artifactId, edges);
  }

  return input.artifacts.map((artifact) => {
    const links = [...(artifact.links ?? [])];
    const linkedTargetIds = new Set(
      links
        .map((link) => link.toKnowledgePageId)
        .filter((id): id is string => Boolean(id)),
    );

    if (summary?.artifactId === artifact.artifactId) {
      for (const target of localTargets) {
        if (
          target.artifactId === summary.artifactId ||
          linkedTargetIds.has(target.artifactId)
        ) {
          continue;
        }
        links.push(
          directLink({
            target,
            linkType: 'mentions',
            linkText: target.title,
            sourceRef,
          }),
        );
        linkedTargetIds.add(target.artifactId);
      }
    }

    for (const target of targets) {
      if (
        target.artifactId === artifact.artifactId ||
        linkedTargetIds.has(target.artifactId) ||
        !containsExactTitle(
          `${artifact.title}\n${artifact.contentMarkdown}`,
          target.title,
        )
      ) {
        continue;
      }
      links.push(
        directLink({
          target,
          linkType: 'catalog_mention',
          linkText: target.title,
          sourceRef,
        }),
      );
      linkedTargetIds.add(target.artifactId);
      if (linkedTargetIds.size >= 12) break;
    }

    return {
      ...artifact,
      links,
      graphEdges: semanticEdgesByArtifactId.get(artifact.artifactId) ?? [],
    };
  });
}

function relationshipTargets(
  artifacts: CompiledKnowledgeArtifact[],
  catalog: CompileSpaceInput['catalog'],
): RelationshipTarget[] {
  const targetsByLookupKey = new Map<string, RelationshipTarget>();
  for (const entry of catalog ?? []) {
    if (!entry.artifactId) continue;
    targetsByLookupKey.set(
      artifactLookupKey(
        entry.artifactKind,
        normalizeCanonicalKey(entry.canonicalKey),
      ),
      {
        artifactId: entry.artifactId,
        artifactKind: entry.artifactKind,
        canonicalKey: normalizeCanonicalKey(entry.canonicalKey),
        title: entry.title,
        local: false,
      },
    );
  }
  for (const artifact of artifacts) {
    if (!artifact.artifactKind || !artifact.canonicalKey) continue;
    targetsByLookupKey.set(
      artifactLookupKey(artifact.artifactKind, artifact.canonicalKey),
      {
        artifactId: artifact.artifactId,
        artifactKind: artifact.artifactKind,
        canonicalKey: artifact.canonicalKey,
        title: artifact.title,
        local: true,
      },
    );
  }
  return [...targetsByLookupKey.values()];
}

function groupByCanonicalKey(
  targets: RelationshipTarget[],
): Map<string, RelationshipTarget[]> {
  const grouped = new Map<string, RelationshipTarget[]>();
  for (const target of targets) {
    const key = normalizeCanonicalKey(target.canonicalKey);
    grouped.set(key, [...(grouped.get(key) ?? []), target]);
  }
  return grouped;
}

function uniqueCanonicalTarget(
  grouped: Map<string, RelationshipTarget[]>,
  canonicalKey: string,
): RelationshipTarget | undefined {
  const targets = grouped.get(normalizeCanonicalKey(canonicalKey)) ?? [];
  const distinct = [
    ...new Map(targets.map((target) => [target.artifactId, target])).values(),
  ];
  return distinct.length === 1 ? distinct[0] : undefined;
}

function directLink(input: {
  target: RelationshipTarget;
  linkType: string;
  linkText: string;
  sourceRef: KnowledgeSourceRef;
}): NonNullable<CompiledKnowledgeArtifact['links']>[number] {
  return {
    linkType: input.linkType,
    linkText: input.linkText,
    targetSpaceId: input.sourceRef.spaceId,
    targetArtifactKind: input.target.artifactKind,
    targetCanonicalKey: input.target.canonicalKey,
    toKnowledgePageId: input.target.artifactId,
    isOpaque: false,
    isDangling: false,
    inputSourceRefs: [input.sourceRef],
  };
}

function containsExactTitle(haystack: string, title: string): boolean {
  const needle = title.trim();
  if (needle.length < 2) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = /^[\x00-\x7f]+$/.test(needle)
    ? `(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`
    : escaped;
  return new RegExp(boundary, 'iu').test(haystack);
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
