import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import {
  CompiledKnowledgeArtifactKind,
  KnowledgeArtifactCatalogEntry,
} from '../types/compiler-artifact.types';

const PAGE_ARTIFACT_KINDS = new Set<CompiledKnowledgeArtifactKind>([
  'source_summary',
  'concept',
  'entity',
  'comparison',
]);
const CATALOG_SUMMARY_LIMIT = 2_000;

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
}
