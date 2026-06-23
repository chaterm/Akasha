import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { KnowledgeSourceSnapshot } from '../types/source-snapshot.types';

@Injectable()
export class KnowledgeSourceExporterService {
  constructor(private readonly pageRepo: PageRepo) {}

  async exportSpaceSources(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<KnowledgeSourceSnapshot[]> {
    const pages = await this.pageRepo.findPagesForKnowledgeExport(input);

    return pages.map((page) => {
      const text = page.textContent ?? '';
      const title = page.title ?? '';
      return {
        workspaceId: page.workspaceId,
        spaceId: page.spaceId,
        sourcePageId: page.id,
        sourceVersion: page.updatedAt.toISOString(),
        contentHash: `sha256:${hashSource(title, text)}`,
        title,
        text,
        references: [],
      };
    });
  }
}

function hashSource(title: string, text: string): string {
  return createHash('sha256').update(title).update('\n').update(text).digest('hex');
}
