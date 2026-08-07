import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';
import {
  CompiledKnowledgeArtifactKind,
  KnowledgeArtifactCatalogEntry,
} from '../types/compiler-artifact.types';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';
import { SemanticAnalysis } from '../compiler/semantic-compiler.schema';
import { CompilerCatalogCandidateRow } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';

const PAGE_ARTIFACT_KINDS = new Set<CompiledKnowledgeArtifactKind>([
  'source_summary',
  'concept',
  'entity',
  'comparison',
]);
export type CompilerCatalogSelection = {
  entries: KnowledgeArtifactCatalogEntry[];
  candidateIds: string[];
  candidateHash: string;
};

const ANALYSIS_CATALOG_LIMIT = 24;
const GENERATION_CATALOG_LIMIT = 64;

@Injectable()
export class KnowledgeArtifactCatalogService {
  constructor(private readonly capsuleRepo: KnowledgeCapsuleRepo) {}

  async findAnalysisCandidates(input: {
    source: KnowledgeSourceSnapshot;
  }): Promise<CompilerCatalogSelection> {
    const source = input.source;
    const rows = await this.capsuleRepo.findCompilerCatalogCandidates({
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      signals: [source.title, ...extractHeadings(source.text)],
      explicitSourcePageIds: explicitReferencePageIds(source),
      limit: ANALYSIS_CATALOG_LIMIT * 4,
    });
    return selectionFromRows(rows, ANALYSIS_CATALOG_LIMIT);
  }

  async findGenerationCandidates(input: {
    source: KnowledgeSourceSnapshot;
    analysis: SemanticAnalysis;
    analysisCandidates: KnowledgeArtifactCatalogEntry[];
  }): Promise<CompilerCatalogSelection> {
    const source = input.source;
    const rows = await this.capsuleRepo.findCompilerCatalogCandidates({
      workspaceId: source.workspaceId,
      spaceId: source.spaceId,
      signals: generationSignals(input.analysis),
      explicitSourcePageIds: explicitReferencePageIds(source),
      limit: GENERATION_CATALOG_LIMIT * 4,
    });
    const preRows: CompilerCatalogCandidateRow[] = input.analysisCandidates.map(
      (entry) => ({
        artifactId: entry.artifactId ?? '',
        artifactKind: entry.artifactKind,
        canonicalKey: entry.canonicalKey,
        title: entry.title,
        explicitMatch: false,
        canonicalExactMatch: false,
        titleExactMatch: false,
        exactMatch: false,
        trigramScore: 0,
        ftsMatch: false,
      }),
    );
    const byId = new Map<string, CompilerCatalogCandidateRow>();
    for (const row of [...rows, ...preRows]) {
      if (row.artifactId && !byId.has(row.artifactId)) {
        byId.set(row.artifactId, row);
      }
    }
    return selectionFromRows([...byId.values()], GENERATION_CATALOG_LIMIT);
  }
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function selectionFromRows(
  rows: CompilerCatalogCandidateRow[],
  limit: number,
): CompilerCatalogSelection {
  const supported = rows.filter(
    (
      row,
    ): row is CompilerCatalogCandidateRow & {
      artifactKind: CompiledKnowledgeArtifactKind;
    } => PAGE_ARTIFACT_KINDS.has(row.artifactKind as never),
  );
  const firstPassMaximum =
    limit === ANALYSIS_CATALOG_LIMIT
      ? { source_summary: 6, concept: 8, entity: 8, comparison: 2 }
      : { source_summary: 16, concept: 20, entity: 20, comparison: 8 };
  const selected: typeof supported = [];
  const skipped: typeof supported = [];
  const counts = new Map<string, number>();
  for (const row of supported) {
    const count = counts.get(row.artifactKind) ?? 0;
    const maximum = firstPassMaximum[row.artifactKind];
    if (selected.length < limit && count < maximum) {
      selected.push(row);
      counts.set(row.artifactKind, count + 1);
    } else {
      skipped.push(row);
    }
  }
  // Unused reservations are returned to globally ranked candidates. Summary
  // retains a hard cap so one-per-page summaries cannot crowd out concepts.
  for (const row of skipped) {
    if (selected.length >= limit) break;
    if (row.artifactKind === 'source_summary') continue;
    selected.push(row);
  }
  const entries = selected.map((row) => ({
    artifactId: row.artifactId,
    artifactKind: row.artifactKind,
    canonicalKey: row.canonicalKey,
    title: row.title,
  }));
  const candidateIds = entries.flatMap((entry) =>
    entry.artifactId ? [entry.artifactId] : [],
  );
  return {
    entries,
    candidateIds,
    candidateHash: digest(JSON.stringify(entries)),
  };
}

function extractHeadings(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .flatMap((line) => {
      const heading = /^#{1,6}\s+(.+)$/u.exec(line.trim())?.[1]?.trim();
      return heading ? [heading] : [];
    })
    .slice(0, 32);
}

function explicitReferencePageIds(source: KnowledgeSourceSnapshot): string[] {
  return [
    ...new Set(
      source.references.flatMap((reference) =>
        reference.targetSpaceId === source.spaceId
          ? [reference.targetPageId]
          : [],
      ),
    ),
  ];
}

function generationSignals(analysis: SemanticAnalysis): string[] {
  return [
    ...analysis.entities.flatMap((entity) => [
      entity.canonicalKey,
      entity.name,
    ]),
    ...analysis.concepts.flatMap((concept) => [
      concept.canonicalKey,
      concept.name,
    ]),
    ...analysis.relations.flatMap((relation) => [
      relation.fromCanonicalKey,
      relation.toCanonicalKey,
    ]),
    ...analysis.comparisons.flatMap((comparison) => [
      comparison.canonicalKey,
      ...comparison.subjects,
    ]),
  ];
}
