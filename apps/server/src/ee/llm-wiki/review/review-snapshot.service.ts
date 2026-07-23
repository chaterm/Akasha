import { Injectable } from '@nestjs/common';
import { KnowledgeReviewApplicationRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-application.repo';
import { KnowledgeReviewSnapshotRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-snapshot.repo';
import { KnowledgeReviewApplication as KnowledgeReviewApplicationRow } from '@akasha/db/types/entity.types';
import { ReviewDocMeta } from './knowledge-artifact-wiki-source';
import {
  reviewApplicationSchema,
  reviewSnapshotSchema,
  ReviewApplication,
  ReviewJob,
  ReviewJobKind,
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
    const current = await this.loadSnapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    const row = await this.reviewSnapshotRepo.upsertSnapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      version: '2',
      items: input.items,
      docs: input.docs,
      resolvedReviews: [],
      jobs: current?.jobs ?? [],
      discoveredAt: current ? new Date(current.discoveredAt) : new Date(),
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
      jobs: current?.jobs ?? [],
      discoveredAt: current ? new Date(current.discoveredAt) : new Date(),
    });

    const applications = await this.reviewApplicationRepo.findBySpace({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    return this.toSnapshot(row, applications);
  }

  async beginJob(input: {
    workspaceId: string;
    spaceId: string;
    jobId: string;
    kind: ReviewJobKind;
    itemId?: string | null;
  }): Promise<{ job: ReviewJob; isNew: boolean }> {
    const current = await this.loadSnapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    const existing = current?.jobs.find(
      (job) =>
        job.jobId === input.jobId &&
        (job.status === 'pending' || job.status === 'running'),
    );
    if (existing) {
      return { job: existing, isNew: false };
    }

    const now = new Date().toISOString();
    const job: ReviewJob = {
      jobId: input.jobId,
      kind: input.kind,
      itemId: input.itemId ?? null,
      status: 'pending',
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };

    await this.saveJobs(
      input.workspaceId,
      input.spaceId,
      upsertJob(current?.jobs ?? [], job),
      current,
    );
    return { job, isNew: true };
  }

  async markJobRunning(input: {
    workspaceId: string;
    spaceId: string;
    jobId: string;
  }): Promise<ReviewJob | null> {
    return this.updateJob(input, (job) => ({
      ...job,
      status: 'running',
      error: null,
      startedAt: job.startedAt ?? new Date().toISOString(),
      finishedAt: null,
    }));
  }

  async markJobDone(input: {
    workspaceId: string;
    spaceId: string;
    jobId: string;
  }): Promise<ReviewJob | null> {
    return this.updateJob(input, (job) => ({
      ...job,
      status: 'done',
      error: null,
      finishedAt: new Date().toISOString(),
    }));
  }

  async markJobFailed(input: {
    workspaceId: string;
    spaceId: string;
    jobId: string;
    error: string;
  }): Promise<ReviewJob | null> {
    return this.updateJob(input, (job) => ({
      ...job,
      status: 'failed',
      error: input.error,
      finishedAt: new Date().toISOString(),
    }));
  }

  async getJob(input: {
    workspaceId: string;
    spaceId: string;
    jobId: string;
  }): Promise<{ snapshot: ReviewSnapshot; job: ReviewJob } | null> {
    const snapshot = await this.loadSnapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    if (!snapshot) return null;
    const job = snapshot.jobs.find((entry) => entry.jobId === input.jobId);
    return job ? { snapshot, job } : null;
  }

  private toSnapshot(
    row: {
      version: string;
      items: unknown;
      docs: unknown;
      resolvedReviews: unknown;
      jobs?: unknown;
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
      jobs: 'jobs' in row ? row.jobs : [],
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

  private async updateJob(
    input: {
      workspaceId: string;
      spaceId: string;
      jobId: string;
    },
    updater: (job: ReviewJob) => ReviewJob,
  ): Promise<ReviewJob | null> {
    const current = await this.loadSnapshot({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
    });
    if (!current) return null;

    let updatedJob: ReviewJob | null = null;
    const jobs = current.jobs.map((job) => {
      if (job.jobId !== input.jobId) return job;
      const next = updater(job);
      updatedJob = next;
      return next;
    });
    if (!updatedJob) return null;

    await this.saveJobs(input.workspaceId, input.spaceId, jobs, current);
    return updatedJob;
  }

  private async saveJobs(
    workspaceId: string,
    spaceId: string,
    jobs: ReviewJob[],
    current?: ReviewSnapshot | null,
  ): Promise<ReviewSnapshot> {
    const row = await this.reviewSnapshotRepo.upsertSnapshot({
      workspaceId,
      spaceId,
      version: current?.version ?? '2',
      items: current?.items ?? [],
      docs: current?.docs ?? [],
      resolvedReviews: current?.resolvedReviews ?? [],
      jobs,
      discoveredAt: current ? new Date(current.discoveredAt) : new Date(),
    });

    const applications = await this.reviewApplicationRepo.findBySpace({
      workspaceId,
      spaceId,
    });
    return this.toSnapshot(row, applications);
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

function upsertJob(current: ReviewJob[], next: ReviewJob): ReviewJob[] {
  const remaining = current.filter((entry) => entry.jobId !== next.jobId);
  return [...remaining, next];
}
