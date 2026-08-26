import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KnowledgeCompilationRepo } from '@akasha/db/repos/llm-wiki/knowledge-compilation.repo';
import { JsonValue } from '@akasha/db/types/db';
import { KNOWLEDGE_COMPILER_LLM_PROVIDER } from '../llm-wiki.constants';
import {
  KnowledgeCompilerLlmError,
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
import { chunkKnowledgeSource } from '../chunking/knowledge-structural-chunker';
import { buildEffectiveKnowledgeHash } from '../services/knowledge-effective-hash';
import { KnowledgeOperationBudget } from '../services/knowledge-operation-budget';
import { SEMANTIC_COMPILER_LIMITS } from '../compiler/semantic-compiler.limits';
import { extractKnowledgeTableRows } from '../../../common/helpers/prosemirror/table-text';
import {
  CompilerCatalogSelection,
  KnowledgeArtifactCatalogService,
} from '../services/knowledge-artifact-catalog.service';

@Injectable()
export class SemanticKnowledgeCompilerRunner implements LlmWikiCompilerRunner {
  constructor(
    @Inject(KNOWLEDGE_COMPILER_LLM_PROVIDER)
    private readonly provider: KnowledgeCompilerLlmProvider,
    private readonly compilationRepo: KnowledgeCompilationRepo,
    @Optional()
    private readonly catalogService?: KnowledgeArtifactCatalogService,
  ) {}

  async compileSpace(input: CompileSpaceInput): Promise<CompileSpaceResult> {
    if (input.sources.length !== 1) {
      throw new Error('semantic compilation requires exactly one source page');
    }
    const source = input.sources[0];
    const operationBudget =
      input.operationBudget ?? new KnowledgeOperationBudget();
    input.operationBudget = operationBudget;
    operationBudget.throwIfAborted();
    if (!source.text.trim()) {
      throw new Error(
        'semantic compilation cannot compile an empty source page',
      );
    }

    const compilerRunId = `${input.workspaceId}:${input.spaceId}:${this.now().toISOString()}`;
    const compileTaskId =
      input.compileTaskId ?? `akasha-page:${source.sourcePageId}`;
    const warnings: CompileDiagnostic[] = [];

    await this.compilationRepo.updateStage({
      workspaceId: input.workspaceId,
      sourcePageId: source.sourcePageId,
      compileTaskId,
      stage: 'analysis',
    });
    const analysisStage = await this.loadOrAnalyze(
      input,
      source,
      compileTaskId,
    );
    const analysis = analysisStage.analysis;

    const generationCatalog = this.catalogService
      ? await this.catalogService.findGenerationCandidates({
          source,
          analysis,
          analysisCandidates: analysisStage.catalog.entries,
        })
      : legacyCatalogSelection(input.catalog ?? []);

    await this.compilationRepo.updateStage({
      workspaceId: input.workspaceId,
      sourcePageId: source.sourcePageId,
      compileTaskId,
      stage: 'generation',
    });
    const generationMessages = buildSemanticGenerationMessages({
      sourcePageId: source.sourcePageId,
      sourceTitle: source.title,
      sourceText: source.text,
      analysis,
      purpose: input.purpose,
      schema: input.schema,
      catalog: generationCatalog.entries,
    });
    await this.recordCandidates({
      input,
      source,
      compileTaskId,
      stage: 'generation',
      selection: {
        ...generationCatalog,
        candidateHash:
          generationMessages.catalogCandidateHash ??
          generationCatalog.candidateHash,
      },
    });
    const generationBudget = await this.checkGenerationAttemptBudget({
      input,
      source,
      compileTaskId,
    });
    assertGenerationAttemptAllowed(generationBudget);
    const generationFallback = input.hasLastSuccess
      ? undefined
      : {
          canonicalKey: source.sourcePageId,
          title: source.title.slice(0, 300),
          markdown: buildBoundedFallbackMarkdown(analysis),
        };
    let generation: Awaited<
      ReturnType<KnowledgeCompilerLlmProvider['generate']>
    >;
    let reservedGeneration = generationBudget;
    try {
      generation = operationBudget.signal
        ? await this.provider.generate(generationMessages, generationFallback, {
            abortSignal: operationBudget.signal,
          })
        : await this.provider.generate(generationMessages, generationFallback);
    } catch (error) {
      if (shouldCountGenerationFailure(error)) {
        reservedGeneration = await this.reserveGenerationAttempt({
          input,
          source,
          compileTaskId,
        });
        assertGenerationAttemptAllowed(reservedGeneration);
      }
      throw error;
    }
    reservedGeneration = await this.reserveGenerationAttempt({
      input,
      source,
      compileTaskId,
    });
    assertGenerationAttemptAllowed(reservedGeneration);
    operationBudget.assertArtifactCount(generation.artifacts.length);
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

    const normalizedDrafts = carryAnalysisClaimsIntoSummary(
      generation.artifacts.map((artifact) => ({
        ...artifact,
        canonicalKey:
          artifact.kind === 'source_summary'
            ? source.sourcePageId
            : normalizeCanonicalKey(artifact.canonicalKey),
      })),
      analysis,
    );
    assertUniqueArtifacts(normalizedDrafts);
    const idByKey = new Map<string, string>();
    for (const entry of generationCatalog.entries) {
      if (!entry.artifactId) continue;
      const normalizedKey = normalizeCanonicalKey(entry.canonicalKey);
      // Artifacts without a canonical key (e.g. source_summary/overview) cannot
      // be resolved as link targets, and would otherwise collide on "kind:".
      if (!normalizedKey) continue;
      idByKey.set(
        artifactLookupKey(entry.artifactKind, normalizedKey),
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
      input: { ...input, catalog: generationCatalog.entries },
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
      resultQuality:
        generation.compilerRecovery === 'source_summary_fallback'
          ? 'degraded'
          : 'normal',
      generationAttemptCount: reservedGeneration.attemptCount,
    };
  }

  protected now(): Date {
    return new Date();
  }

  private async loadOrAnalyze(
    input: CompileSpaceInput,
    source: KnowledgeSourceSnapshot,
    compileTaskId: string,
  ): Promise<{
    analysis: SemanticAnalysis;
    catalog: CompilerCatalogSelection;
  }> {
    const catalog = this.catalogService
      ? await this.catalogService.findAnalysisCandidates({ source })
      : legacyCatalogSelection(input.catalog ?? []);
    const sourceEffectiveKnowledgeHash =
      source.effectiveKnowledgeHash ??
      buildEffectiveKnowledgeHash({
        sourceContentHash: source.contentHash,
        sourceTextHash: `sha256:${sha256(source.text)}`,
        compilerVersion: input.compilerVersion,
        promptVersion: input.promptVersion,
        readyImages: [],
      });
    const messages = buildSemanticAnalysisMessages({
      sourceTitle: source.title,
      sourceText: source.text,
      purpose: input.purpose,
      schema: input.schema,
      catalog: catalog.entries,
    });
    const candidateHash =
      messages.catalogCandidateHash ?? catalog.candidateHash;
    await this.recordCandidates({
      input,
      source,
      compileTaskId,
      stage: 'analysis',
      selection: { ...catalog, candidateHash },
    });
    const effectiveKnowledgeHash = analysisCacheHash({
      sourceEffectiveKnowledgeHash,
      providerIdentity:
        (await this.provider.getCacheIdentity?.()) ?? 'provider:unspecified',
      promptVersion: input.promptVersion,
      catalogCandidateHash: candidateHash,
    });
    const cacheKey = {
      workspaceId: input.workspaceId,
      sourcePageId: source.sourcePageId,
      effectiveKnowledgeHash,
      compilerVersion: input.compilerVersion,
      promptVersion: input.promptVersion,
    };
    const cached = input.bypassCache
      ? undefined
      : await this.compilationRepo.findAnalysis(cacheKey);
    const parsedCache = semanticAnalysisSchema.safeParse(cached);
    if (parsedCache.success) return { analysis: parsedCache.data, catalog };

    const analysis = input.operationBudget?.signal
      ? await this.provider.analyze(messages, {
          abortSignal: input.operationBudget.signal,
        })
      : await this.provider.analyze(messages);
    await this.compilationRepo.saveAnalysis({
      ...cacheKey,
      spaceId: input.spaceId,
      sourceVersion: source.sourceVersion,
      analysis: analysis as unknown as JsonValue,
      publicationGuard: input.publicationGuard,
    });
    return { analysis, catalog };
  }

  private async recordCandidates(input: {
    input: CompileSpaceInput;
    source: KnowledgeSourceSnapshot;
    compileTaskId: string;
    stage: 'analysis' | 'generation';
    selection: CompilerCatalogSelection;
  }): Promise<void> {
    const repo = this.compilationRepo as KnowledgeCompilationRepo & {
      recordCompilerCandidates?: KnowledgeCompilationRepo['recordCompilerCandidates'];
    };
    await repo.recordCompilerCandidates?.({
      workspaceId: input.input.workspaceId,
      sourcePageId: input.source.sourcePageId,
      compileTaskId: input.compileTaskId,
      stage: input.stage,
      compilerModel:
        (await this.provider.getCompilerModel?.()) ??
        input.input.compilerVersion,
      compilerProfile:
        (await this.provider.getCacheIdentity?.()) ?? 'provider:unspecified',
      candidateIds: input.selection.candidateIds,
      candidateHash: input.selection.candidateHash,
    });
  }

  private async reserveGenerationAttempt(input: {
    input: CompileSpaceInput;
    source: KnowledgeSourceSnapshot;
    compileTaskId: string;
  }): Promise<{ allowed: boolean; attemptCount: number }> {
    const repo = this.compilationRepo as KnowledgeCompilationRepo & {
      reserveGenerationAttempt?: KnowledgeCompilationRepo['reserveGenerationAttempt'];
    };
    return (
      (await repo.reserveGenerationAttempt?.({
        workspaceId: input.input.workspaceId,
        sourcePageId: input.source.sourcePageId,
        compileTaskId: input.compileTaskId,
        sourceContentHash: input.source.contentHash,
        reset: input.input.bypassCache === true,
      })) ?? { allowed: true, attemptCount: 1 }
    );
  }

  private async checkGenerationAttemptBudget(input: {
    input: CompileSpaceInput;
    source: KnowledgeSourceSnapshot;
    compileTaskId: string;
  }): Promise<{ allowed: boolean; attemptCount: number }> {
    const repo = this.compilationRepo as KnowledgeCompilationRepo & {
      checkGenerationAttemptBudget?: KnowledgeCompilationRepo['checkGenerationAttemptBudget'];
    };
    return (
      (await repo.checkGenerationAttemptBudget?.({
        workspaceId: input.input.workspaceId,
        sourcePageId: input.source.sourcePageId,
        compileTaskId: input.compileTaskId,
        sourceContentHash: input.source.contentHash,
        reset: input.input.bypassCache === true,
      })) ?? { allowed: true, attemptCount: 0 }
    );
  }
}

function assertGenerationAttemptAllowed(input: {
  allowed: boolean;
  attemptCount: number;
}): void {
  if (input.allowed) return;
  throw new KnowledgeCompilerLlmError(
    'invalid_output',
    'Knowledge generation retry budget is exhausted for this source content.',
    false,
  );
}

function shouldCountGenerationFailure(error: unknown): boolean {
  return (
    error instanceof KnowledgeCompilerLlmError &&
    error.code === 'invalid_output'
  );
}

function legacyCatalogSelection(
  entries: CompileSpaceInput['catalog'] extends infer T
    ? NonNullable<T>
    : never,
): CompilerCatalogSelection {
  const bounded = entries.slice(0, 64);
  return {
    entries: bounded,
    candidateIds: bounded.flatMap((entry) =>
      entry.artifactId ? [entry.artifactId] : [],
    ),
    candidateHash: `sha256:${sha256(
      JSON.stringify(
        bounded.map(({ artifactKind, canonicalKey, title }) => ({
          artifactKind,
          canonicalKey,
          title,
        })),
      ),
    )}`,
  };
}

function analysisCacheHash(input: {
  sourceEffectiveKnowledgeHash: string;
  providerIdentity: string;
  promptVersion: string;
  catalogCandidateHash: string;
}): string {
  return `sha256:${sha256(
    JSON.stringify({
      sourceEffectiveKnowledgeHash: input.sourceEffectiveKnowledgeHash,
      providerIdentity: input.providerIdentity,
      promptVersion: input.promptVersion,
      catalogCandidateHash: input.catalogCandidateHash,
    }),
  )}`;
}

function buildBoundedFallbackMarkdown(analysis: SemanticAnalysis): string {
  // Reserve half of the fallback budget for structured claims/evidence so an
  // unexpectedly verbose (but valid) synopsis cannot crowd them out.
  const sections = [
    analysis.synopsis
      .trim()
      .slice(0, Math.floor(SEMANTIC_COMPILER_LIMITS.fallbackMarkdownChars / 2)),
  ];
  if (analysis.claims.length > 0) {
    sections.push(
      [
        '## Key claims',
        ...analysis.claims.map(
          (claim) => `- ${claim.text}\n  - Evidence: “${claim.evidenceQuote}”`,
        ),
      ].join('\n'),
    );
  }
  return sections
    .join('\n\n')
    .trim()
    .slice(0, SEMANTIC_COMPILER_LIMITS.fallbackMarkdownChars);
}

function carryAnalysisClaimsIntoSummary(
  artifacts: SemanticGeneratedArtifact[],
  analysis: SemanticAnalysis,
): SemanticGeneratedArtifact[] {
  if (analysis.claims.length === 0) return artifacts;

  return artifacts.map((artifact) => {
    if (artifact.kind !== 'source_summary') return artifact;
    const seen = new Set(
      artifact.claims.map((claim) => normalizeClaimText(claim.text)),
    );
    const recovered = analysis.claims.filter((claim) => {
      const key = normalizeClaimText(claim.text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      ...artifact,
      claims: [...artifact.claims, ...recovered].slice(0, 200),
    };
  });
}

function normalizeClaimText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
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
  const structuralChunks = structuralParents.flatMap((parent) =>
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
  const chunks = [
    ...structuralChunks,
    ...(input.artifact.kind === 'source_summary'
      ? [
          ...tableRowEvidenceChunks(
            input.source,
            input.artifact.title,
            sourceRef,
          ),
        ]
      : []),
  ];
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

function tableRowEvidenceChunks(
  source: KnowledgeSourceSnapshot,
  artifactTitle: string,
  sourceRef: KnowledgeSourceRef,
) {
  let sourceCursor = 0;
  return extractKnowledgeTableRows(source.content).map((row) => {
    const startOffset = source.text.indexOf(row.text, sourceCursor);
    const endOffset =
      startOffset >= 0 ? startOffset + row.text.length : undefined;
    if (startOffset >= 0) sourceCursor = endOffset!;
    const rowSourceRef =
      startOffset >= 0
        ? {
            ...sourceRef,
            sourceRange: { startOffset, endOffset: endOffset! },
            quoteHash: `sha256:${sha256(row.text)}`,
          }
        : sourceRef;
    const text = `${artifactTitle} Table row ${row.rowIndex + 1}: ${row.text}`;
    return {
      text,
      claimIndex: null,
      inputSourceRefs: [rowSourceRef],
      contentHash: `sha256:${sha256(row.text)}`,
      stableKey: `table-row:${row.tableIndex}:${row.rowIndex}`,
      parentStableKey: null,
      chunkRole: 'standalone' as const,
      retrievalChannel: 'evidence' as const,
      headingPath: [],
      startOffset,
      endOffset,
      embeddingText: `${source.title}\n${text}`,
    };
  });
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
  const boundary = isAscii(needle)
    ? `(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`
    : escaped;
  return new RegExp(boundary, 'iu').test(haystack);
}

function isAscii(value: string): boolean {
  return [...value].every((character) => character.codePointAt(0)! <= 0x7f);
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

function normalizeCanonicalKey(value: string | null | undefined): string {
  // Stored source_summary/overview artifacts legitimately have a null
  // canonicalKey, so guard against it rather than assuming a string.
  return (value ?? '').trim().toLocaleLowerCase('en-US');
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
