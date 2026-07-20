import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { BacklinkRepo } from '@akasha/db/repos/backlink/backlink.repo';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';

@Injectable()
export class KnowledgeSourceExporterService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly backlinkRepo: BacklinkRepo,
  ) {}

  async exportSpaceSources(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<KnowledgeSourceSnapshot[]> {
    const pages = await this.pageRepo.findPagesForKnowledgeExport(input);
    return this.toSnapshots(input.workspaceId, pages);
  }

  async exportPageSources(input: {
    workspaceId: string;
    spaceId: string;
    sourcePageIds: string[];
  }): Promise<KnowledgeSourceSnapshot[]> {
    const pages = await this.pageRepo.findPagesByIdsForKnowledgeExport({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      pageIds: input.sourcePageIds,
    });
    return this.toSnapshots(input.workspaceId, pages);
  }

  private async toSnapshots(
    workspaceId: string,
    pages: Array<{
      id: string;
      workspaceId: string;
      spaceId: string;
      title: string;
      textContent: string | null;
      content: unknown;
      updatedAt: Date;
    }>,
  ): Promise<KnowledgeSourceSnapshot[]> {
    const references = await this.backlinkRepo.findOutgoingPageReferences({
      workspaceId,
      sourcePageIds: pages.map((page) => page.id),
    });
    const referencesBySourcePageId = groupBy(
      references,
      (reference) => reference.sourcePageId,
    );

    return pages.map((page) => {
      const text = page.textContent ?? '';
      const title = page.title ?? '';
      return {
        workspaceId: page.workspaceId,
        spaceId: page.spaceId,
        sourcePageId: page.id,
        sourceVersion: page.updatedAt.toISOString(),
        contentHash: `sha256:${hashSource(title, text, page.content)}`,
        title,
        text,
        content: page.content ?? undefined,
        references: (referencesBySourcePageId.get(page.id) ?? []).map(
          (reference) => ({
            sourcePageId: page.id,
            targetPageId: reference.targetPageId,
            targetSpaceId: reference.targetSpaceId,
            kind:
              reference.targetSpaceId === page.spaceId
                ? ('same_space_reference' as const)
                : ('cross_space_reference' as const),
            mode: 'opaque' as const,
          }),
        ),
      };
    });
  }
}

function groupBy<T>(
  values: T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return grouped;
}

function hashSource(title: string, text: string, content: unknown): string {
  return createHash('sha256')
    .update(title)
    .update('\n')
    .update(text)
    .update('\n')
    .update(content ? JSON.stringify(content) : '')
    .digest('hex');
}
