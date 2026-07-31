import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import {
  CompiledKnowledgeArtifactKind,
  KnowledgeArtifactCatalogEntry,
} from '../types/compiler-artifact.types';
import { KnowledgeSourceRef } from '../types/knowledge.types';

const PAGE_ARTIFACT_KINDS = new Set<CompiledKnowledgeArtifactKind>([
  'source_summary',
  'concept',
  'entity',
  'comparison',
]);
const CATALOG_SUMMARY_LIMIT = 2_000;
const AGGREGATE_FINGERPRINT_LIMIT = 5_000;
const AGGREGATE_FINGERPRINT_VERSION = 'akasha-space-aggregate-input-v1';

export const EMPTY_KNOWLEDGE_AGGREGATE_HASH = digest(
  JSON.stringify({
    version: AGGREGATE_FINGERPRINT_VERSION,
    artifactCount: 0,
    truncated: false,
    pages: [],
  }),
);

export type ActiveKnowledgeArtifactCatalogEntry =
  KnowledgeArtifactCatalogEntry & {
    artifactId: string;
    summary: string;
  };

export type KnowledgeArtifactCatalogSnapshot = {
  entries: ActiveKnowledgeArtifactCatalogEntry[];
  hash: string;
};

@Injectable()
export class KnowledgeArtifactCatalogService {
  constructor(private readonly capsuleRepo: KnowledgeCapsuleRepo) {}

  async snapshot(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<KnowledgeArtifactCatalogSnapshot> {
    const rows = await this.capsuleRepo.findActiveArtifactCatalog(input);
    const entries = rows
      .filter(
        (
          row,
        ): row is typeof row & {
          artifactKind: CompiledKnowledgeArtifactKind;
        } => PAGE_ARTIFACT_KINDS.has(row.artifactKind as never),
      )
      .map((row) => ({
        artifactId: row.artifactId,
        artifactKind: row.artifactKind,
        canonicalKey: row.canonicalKey,
        title: row.title,
        summary: row.body.slice(0, CATALOG_SUMMARY_LIMIT),
      }))
      .sort((a, b) =>
        `${a.artifactKind}:${a.canonicalKey}`.localeCompare(
          `${b.artifactKind}:${b.canonicalKey}`,
          'en',
        ),
      );
    const serialized = JSON.stringify(entries);
    return {
      entries,
      hash: `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
    };
  }

  /**
   * Fingerprints exactly the active page inputs consumed by Space aggregation.
   * Volatile timestamps and job ids are excluded. The page body and sorted
   * source refs are hashed so a contribution or materialized body change
   * invalidates aggregate reuse without storing the full prompt in the Run.
   */
  async aggregateFingerprint(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<{ hash: string; artifactCount: number; truncated: boolean }> {
    const aggregateInput = await this.aggregateInput(input);
    return aggregateInput.fingerprint;
  }

  async aggregateInput(input: {
    workspaceId: string;
    spaceId: string;
    abortSignal?: AbortSignal;
  }) {
    input.abortSignal?.throwIfAborted();
    const scope = {
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    };
    const [candidates, totalArtifactCount] = await Promise.all([
      this.capsuleRepo.findAggregateCandidatesForSpace({
        ...scope,
        limit: AGGREGATE_FINGERPRINT_LIMIT,
      }),
      this.capsuleRepo.countActiveAggregateArtifacts(scope),
    ]);
    input.abortSignal?.throwIfAborted();
    const pages = candidates.pages
      .filter(
        (page) =>
          page.canonicalKey &&
          page.pageType &&
          PAGE_ARTIFACT_KINDS.has(page.pageType as never),
      )
      .sort((left, right) =>
        `${left.pageType}:${left.canonicalKey}:${left.id}`.localeCompare(
          `${right.pageType}:${right.canonicalKey}:${right.id}`,
          'en',
        ),
      );
    const truncated = totalArtifactCount > pages.length;
    const includedPageIds = new Set(pages.map((page) => page.id));
    const sourcesByPage = new Map<string, string[]>();
    const sourceRefsByArtifact = new Map<string, KnowledgeSourceRef[]>();
    for (const source of candidates.pageSources) {
      if (!includedPageIds.has(source.knowledgePageId)) continue;
      const refs = sourcesByPage.get(source.knowledgePageId) ?? [];
      refs.push(
        [
          source.sourcePageId,
          source.sourceVersion,
          source.contentHash,
          source.provenanceKind,
          source.attachmentId ?? '',
        ].join('\u001f'),
      );
      sourcesByPage.set(source.knowledgePageId, refs);
      const sourceRefs = sourceRefsByArtifact.get(source.knowledgePageId) ?? [];
      sourceRefs.push({
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        sourcePageId: source.sourcePageId,
        sourceVersion: source.sourceVersion,
        contentHash: source.contentHash,
      });
      sourceRefsByArtifact.set(source.knowledgePageId, sourceRefs);
    }
    const payload = {
      version: AGGREGATE_FINGERPRINT_VERSION,
      artifactCount: totalArtifactCount,
      truncated,
      pages: pages.map((page) => ({
        id: page.id,
        kind: page.pageType,
        key: page.canonicalKey,
        title: page.title,
        bodyHash: digest(page.body),
        sources: [...new Set(sourcesByPage.get(page.id) ?? [])].sort(),
      })),
    };
    const allSourceRefs = uniqueSourceRefs(
      pages.flatMap((page) => sourceRefsByArtifact.get(page.id) ?? []),
    );
    return {
      pages,
      sourceRefsByArtifact,
      allSourceRefs,
      fingerprint: {
        hash: digest(JSON.stringify(payload)),
        artifactCount: totalArtifactCount,
        truncated,
      },
    };
  }
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function uniqueSourceRefs(refs: KnowledgeSourceRef[]): KnowledgeSourceRef[] {
  const byKey = new Map<string, KnowledgeSourceRef>();
  for (const ref of refs) {
    byKey.set(
      [
        ref.workspaceId,
        ref.spaceId,
        ref.sourcePageId,
        ref.sourceVersion,
        ref.contentHash,
      ].join('\u001f'),
      ref,
    );
  }
  return [...byKey.values()].sort((left, right) =>
    `${left.sourcePageId}:${left.sourceVersion}:${left.contentHash}`.localeCompare(
      `${right.sourcePageId}:${right.sourceVersion}:${right.contentHash}`,
      'en',
    ),
  );
}
