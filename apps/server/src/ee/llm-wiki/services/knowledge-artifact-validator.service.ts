import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  CompiledKnowledgeArtifact,
  CompiledKnowledgeArtifactKind,
  CompileSpaceInput,
} from '../types/compiler-artifact.types';
import { KnowledgeSourceRef } from '../types/knowledge.types';
import { buildAttachmentEvidenceContent } from '../adapters/knowledge-attachment-evidence';

export interface QuarantinedKnowledgeArtifact {
  artifact: CompiledKnowledgeArtifact;
  reasons: string[];
}

export interface KnowledgeArtifactValidationResult {
  accepted: CompiledKnowledgeArtifact[];
  quarantined: QuarantinedKnowledgeArtifact[];
}

@Injectable()
export class KnowledgeArtifactValidatorService {
  validateCompileResult(input: {
    input: CompileSpaceInput;
    artifacts: CompiledKnowledgeArtifact[];
  }): KnowledgeArtifactValidationResult {
    const accepted: CompiledKnowledgeArtifact[] = [];
    const quarantined: QuarantinedKnowledgeArtifact[] = [];

    for (const artifact of input.artifacts) {
      const reasons = this.validateArtifact(input.input, artifact);
      if (reasons.length > 0) {
        quarantined.push({ artifact, reasons });
      } else {
        accepted.push(artifact);
      }
    }

    return { accepted, quarantined };
  }

  private validateArtifact(
    input: CompileSpaceInput,
    artifact: CompiledKnowledgeArtifact,
  ): string[] {
    const reasons: string[] = [];
    const compileSourcesByKey = new Map(
      input.sources.map((source) => [
        sourceKey(
          source.sourcePageId,
          source.sourceVersion,
          source.contentHash,
        ),
        source,
      ]),
    );

    if (
      artifact.workspaceId !== input.workspaceId ||
      artifact.spaceId !== input.spaceId
    ) {
      reasons.push('artifact scope does not match compile scope');
    }

    if (!isUuid(artifact.artifactId)) {
      reasons.push('artifact id must be a UUID');
    }

    if (
      !artifact.compilerRunId ||
      !artifact.compileTaskId ||
      !artifact.inputSourceRefs?.length
    ) {
      reasons.push('synthesis lineage is incomplete');
    }

    if (
      artifact.artifactKind &&
      !isSupportedArtifactKind(artifact.artifactKind)
    ) {
      reasons.push('artifact kind is not supported');
    }

    const artifactSourceValidation = validateSourceRefs(
      artifact.inputSourceRefs ?? [],
      input,
      compileSourcesByKey,
    );
    if (artifactSourceValidation.hasOutsideCompileInput) {
      reasons.push('artifact source is not in compile input');
    }
    if (artifactSourceValidation.hasInvalidRange) {
      reasons.push('artifact source range is invalid');
    }
    if (artifactSourceValidation.hasQuoteHashMismatch) {
      reasons.push('artifact quote hash does not match source range');
    }

    if (
      artifact.inputSourceRefs?.length &&
      !artifactSourceValidation.hasOutsideCompileInput &&
      !sameStringSet(
        artifact.sourcePageIds,
        artifact.inputSourceRefs.map((source) => source.sourcePageId),
      )
    ) {
      reasons.push('artifact source page ids must match synthesis lineage');
    }

    validateChildSourceRefs(
      'claim',
      (artifact.claims ?? []).map((claim) => claim.inputSourceRefs),
      input,
      compileSourcesByKey,
      reasons,
    );

    validateChildSourceRefs(
      'chunk',
      (artifact.chunks ?? []).map((chunk) => chunk.inputSourceRefs),
      input,
      compileSourcesByKey,
      reasons,
    );

    validateChunkAttachmentOccurrences(artifact, input, reasons);

    for (const link of artifact.links ?? []) {
      if (
        link.linkType === 'cross_space_reference' &&
        link.targetSpaceId !== input.spaceId &&
        link.isOpaque !== true
      ) {
        reasons.push('cross-space references must be opaque');
        break;
      }
    }

    validateChildSourceRefs(
      'link',
      (artifact.links ?? []).map((link) => link.inputSourceRefs),
      input,
      compileSourcesByKey,
      reasons,
    );

    if (
      (artifact.graphEdges ?? []).some(
        (edge) =>
          (!edge.toKnowledgePageId && !edge.targetCanonicalKey?.trim()) ||
          (edge.toKnowledgePageId != null && !isUuid(edge.toKnowledgePageId)),
      )
    ) {
      reasons.push('graph edge target identity is invalid');
    }

    validateChildSourceRefs(
      'graph edge',
      (artifact.graphEdges ?? []).map((edge) => edge.inputSourceRefs),
      input,
      compileSourcesByKey,
      reasons,
    );

    return reasons;
  }
}

const SUPPORTED_ARTIFACT_KINDS = new Set<CompiledKnowledgeArtifactKind>([
  'source_summary',
  'original_source',
  'concept',
  'entity',
  'comparison',
]);

function isSupportedArtifactKind(
  artifactKind: string,
): artifactKind is CompiledKnowledgeArtifactKind {
  return SUPPORTED_ARTIFACT_KINDS.has(
    artifactKind as CompiledKnowledgeArtifactKind,
  );
}

type SourceValidation = {
  hasOutsideCompileInput: boolean;
  hasInvalidRange: boolean;
  hasQuoteHashMismatch: boolean;
};

function validateChildSourceRefs(
  label: string,
  refsByChild: Array<KnowledgeSourceRef[] | undefined>,
  input: CompileSpaceInput,
  compileSourcesByKey: Map<string, CompileSpaceInput['sources'][number]>,
  reasons: string[],
): void {
  if (refsByChild.length === 0) return;

  if (refsByChild.some((sourceRefs) => !sourceRefs?.length)) {
    reasons.push(`${label} lineage is incomplete`);
  }

  const validation = validateSourceRefs(
    refsByChild.flatMap((sourceRefs) => sourceRefs ?? []),
    input,
    compileSourcesByKey,
  );

  if (validation.hasOutsideCompileInput) {
    reasons.push(`${label} source is not in compile input`);
  }
  if (validation.hasInvalidRange) {
    reasons.push(`${label} source range is invalid`);
  }
  if (validation.hasQuoteHashMismatch) {
    reasons.push(`${label} quote hash does not match source range`);
  }
}

type ChunkAttachmentOccurrence = NonNullable<
  NonNullable<
    CompiledKnowledgeArtifact['chunks']
  >[number]['attachmentOccurrences']
>[number];

type ReconstructedAttachmentBlock = {
  startOffset: number | null;
  endOffset: number | null;
  text: string;
  occurrences: ChunkAttachmentOccurrence[];
};

/**
 * Enforces design §6.2 for chunk attachment relations by INDEPENDENTLY
 * reconstructing the deterministic attachment-evidence blocks from the trusted
 * `attachmentSerializedText` in the compile input, instead of trusting the
 * range and occurrences an artifact declares.
 *
 * A relation is accepted only when its chunk is byte-for-byte a block the
 * deterministic chunker actually produces from the serialized source — same
 * stable key, same range, same cleaned text — and the occurrence is one that
 * block genuinely contains (matched by attachment id + exact marker range) with
 * matching snapshot metadata. This closes the gap where a hand-crafted artifact
 * (e.g. via the admin import endpoint) could wrap a real occurrence in an
 * unrelated chunk with a giant self-declared range: such a chunk matches no
 * reconstructed block and is quarantined. It is fail-closed — a source that
 * omits `attachmentSerializedText` yields no legitimate blocks, so any relation
 * riding on it is rejected rather than trusted.
 */
function validateChunkAttachmentOccurrences(
  artifact: CompiledKnowledgeArtifact,
  input: CompileSpaceInput,
  reasons: string[],
): void {
  const legitByStableKey = new Map<string, ReconstructedAttachmentBlock[]>();
  for (const source of input.sources) {
    const evidence = buildAttachmentEvidenceContent({
      source,
      sourceRef: {
        workspaceId: source.workspaceId,
        spaceId: source.spaceId,
        sourcePageId: source.sourcePageId,
        sourceVersion: source.sourceVersion,
        contentHash: source.contentHash,
      },
      pageTitle: source.title,
    });
    for (const chunk of evidence.chunks) {
      if (!chunk.stableKey) continue;
      const blocks = legitByStableKey.get(chunk.stableKey) ?? [];
      blocks.push({
        startOffset: chunk.startOffset ?? null,
        endOffset: chunk.endOffset ?? null,
        text: chunk.text,
        occurrences: chunk.attachmentOccurrences ?? [],
      });
      legitByStableKey.set(chunk.stableKey, blocks);
    }
  }

  let hasUnverifiable = false;
  let hasSnapshotMismatch = false;
  for (const chunk of artifact.chunks ?? []) {
    const declared = chunk.attachmentOccurrences ?? [];
    if (declared.length === 0) continue;

    // The chunk must BE a real deterministic block, not merely declare a range
    // that happens to cover a marker: same stable key, range and cleaned text.
    const candidates = chunk.stableKey
      ? (legitByStableKey.get(chunk.stableKey) ?? [])
      : [];
    const block = candidates.find(
      (candidate) =>
        candidate.startOffset === (chunk.startOffset ?? null) &&
        candidate.endOffset === (chunk.endOffset ?? null) &&
        candidate.text === chunk.text,
    );
    if (!block) {
      hasUnverifiable = true;
      continue;
    }

    for (const occurrence of declared) {
      const trusted = block.occurrences.find(
        (candidate) =>
          candidate.attachmentId === occurrence.attachmentId &&
          candidate.startOffset === occurrence.startOffset &&
          candidate.endOffset === occurrence.endOffset,
      );
      if (!trusted) {
        hasUnverifiable = true;
        continue;
      }
      if (
        occurrence.sourceVersion !== trusted.sourceVersion ||
        occurrence.sourceContentHash !== trusted.sourceContentHash ||
        occurrence.attachmentUpdatedAt !== trusted.attachmentUpdatedAt
      ) {
        hasSnapshotMismatch = true;
      }
    }
  }

  if (hasUnverifiable) {
    reasons.push(
      'chunk attachment occurrence is not backed by a deterministic source block',
    );
  }
  if (hasSnapshotMismatch) {
    reasons.push('chunk attachment occurrence does not match source snapshot');
  }
}

function validateSourceRefs(
  sources: KnowledgeSourceRef[],
  input: CompileSpaceInput,
  compileSourcesByKey: Map<string, CompileSpaceInput['sources'][number]>,
): SourceValidation {
  const validation: SourceValidation = {
    hasOutsideCompileInput: false,
    hasInvalidRange: false,
    hasQuoteHashMismatch: false,
  };

  for (const source of sources) {
    const key = sourceKey(
      source.sourcePageId,
      source.sourceVersion,
      source.contentHash,
    );
    const compileSource = compileSourcesByKey.get(key);

    if (
      source.workspaceId !== input.workspaceId ||
      source.spaceId !== input.spaceId ||
      !compileSource
    ) {
      validation.hasOutsideCompileInput = true;
      continue;
    }

    if (!source.sourceRange && !source.quoteHash) {
      continue;
    }

    if (!source.sourceRange || !source.quoteHash) {
      validation.hasInvalidRange = true;
      continue;
    }

    if (!isValidSourceRange(source.sourceRange, compileSource.text)) {
      validation.hasInvalidRange = true;
      continue;
    }

    const quote = compileSource.text.slice(
      source.sourceRange.startOffset,
      source.sourceRange.endOffset,
    );
    if (hashQuote(quote) !== source.quoteHash) {
      validation.hasQuoteHashMismatch = true;
    }
  }

  return validation;
}

function sameStringSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);

  if (left.size !== right.size) return false;

  for (const value of left) {
    if (!right.has(value)) return false;
  }

  return true;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isValidSourceRange(
  range: KnowledgeSourceRef['sourceRange'],
  text: string,
): range is NonNullable<KnowledgeSourceRef['sourceRange']> {
  return (
    Boolean(range) &&
    Number.isInteger(range.startOffset) &&
    Number.isInteger(range.endOffset) &&
    range.startOffset >= 0 &&
    range.endOffset > range.startOffset &&
    range.endOffset <= text.length
  );
}

function hashQuote(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function sourceKey(
  sourcePageId: string,
  sourceVersion: string,
  contentHash: string,
): string {
  return `${sourcePageId}:${sourceVersion}:${contentHash}`;
}
