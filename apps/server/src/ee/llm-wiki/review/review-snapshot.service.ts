import { Injectable } from '@nestjs/common';
import { KnowledgeReviewApplicationRepo } from '@docmost/db/repos/llm-wiki/knowledge-review-application.repo';
import { KnowledgeReviewSnapshotRepo } from '@docmost/db/repos/llm-wiki/knowledge-review-snapshot.repo';
import { KnowledgeReviewApplication as KnowledgeReviewApplicationRow } from '@docmost/db/types/entity.types';
import { ReviewDocMeta } from './knowledge-artifact-wiki-source';
import {
  reviewApplicationSchema,
  reviewSnapshotSchema,
  ReviewApplication,
  ReviewItem,
  ReviewSnapshot,
  StoredResolvedReview,
} from './review.schema';
import {
  normalizeResolvedReviewsByDocIds,
  normalizeReviewItemsByDocIds,
} from './review.service';

@Injectable()
export class ReviewSnapshotService {
  constructor(
    private readonly reviewSnapshotRepo: KnowledgeReviewSnapshotRepo,
    private readonly reviewApplicationRepo: KnowledgeReviewApplicationRepo,
  ) {}

  async loadSnapshot(input: {
    workspaceId: string;
    spaceId: string;
  }): Promise<ReviewSnapshot | null> {
    const row = await this.reviewSnapshotRepo.findBySpace(input);
    if (!row) return null;
    const applications = await this.reviewApplicationRepo.findBySpace(input);
    return this.toSnapshot(row, applications);
  }

  async replaceDiscoveredSnapshot(input: {
    workspaceId: string;
    spaceId: string;
    items: ReviewItem[];
    docs: ReviewDocMeta[];
  }): Promise<ReviewSnapshot> {
    const row = await this.reviewSnapshotRepo.upsertSnapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      version: '2',
      items: input.items,
      docs: input.docs,
      resolvedReviews: [],
      discoveredAt: new Date(),
    });

    const applications = await this.reviewApplicationRepo.findBySpace({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    return this.toSnapshot(row, applications);
  }

  async saveResolvedReview(input: {
    workspaceId: string;
    spaceId: string;
    resolved: StoredResolvedReview;
  }): Promise<ReviewSnapshot> {
    const current = await this.loadSnapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    const resolvedReviews = upsertResolvedReview(
      current?.resolvedReviews ?? [],
      input.resolved,
    );

    const row = await this.reviewSnapshotRepo.upsertSnapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      version: current?.version ?? '2',
      items: current?.items ?? [input.resolved.item],
      docs: current?.docs ?? [],
      resolvedReviews,
      discoveredAt: current ? new Date(current.discoveredAt) : new Date(),
    });

    const applications = await this.reviewApplicationRepo.findBySpace({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    return this.toSnapshot(row, applications);
  }

  private toSnapshot(
    row: {
      version: string;
      items: unknown;
      docs: unknown;
      resolvedReviews: unknown;
      discoveredAt: Date;
      updatedAt: Date;
    },
    applications: KnowledgeReviewApplicationRow[] = [],
  ): ReviewSnapshot {
    const snapshot = reviewSnapshotSchema.parse({
      version: row.version,
      items: row.items,
      docs: row.docs,
      resolvedReviews: row.resolvedReviews,
      applications: applications.map(toReviewApplication),
      discoveredAt: row.discoveredAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });

    const docIds = snapshot.docs.map((doc) => doc.id);
    return {
      ...snapshot,
      items: normalizeReviewItemsByDocIds(snapshot.items, docIds),
      resolvedReviews: normalizeResolvedReviewsByDocIds(
        snapshot.resolvedReviews,
        docIds,
      ),
    };
  }
}

function toReviewApplication(
  row: KnowledgeReviewApplicationRow,
): ReviewApplication {
  return reviewApplicationSchema.parse({
    ...row,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    revertedAt: row.revertedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function upsertResolvedReview(
  current: StoredResolvedReview[],
  next: StoredResolvedReview,
): StoredResolvedReview[] {
  const remaining = current.filter((entry) => entry.item.id !== next.item.id);
  return [...remaining, next];
}
