import { createHash } from 'crypto';
import { KnowledgeAdminSpaceAction } from '../types/knowledge-queue.types';

// Image extraction persists a 30-second first retryAfter. A slightly longer
// BullMQ base delay guarantees that each page retry can actually reclaim the
// image cache lease and make another VLM attempt. Exponential 31s/62s delays
// remain bounded enough for an interactive manual retry.
export const KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS = 31_000;

export function buildKnowledgeAdminActionJobId(input: {
  action: KnowledgeAdminSpaceAction;
  workspaceId: string;
  spaceId: string;
  now?: number;
}): string {
  if (input.action === 'rebuild_embeddings') {
    return [
      'knowledge-rebuild-embeddings',
      input.workspaceId,
      input.spaceId,
    ].join('__');
  }
  const prefix =
    input.action === 'reindex_access'
      ? 'knowledge-reindex-access'
      : input.action === 'mark_stale'
        ? 'knowledge-mark-stale'
        : 'knowledge-retry-pages';

  return buildKnowledgeJobId({
    prefix,
    workspaceId: input.workspaceId,
    spaceId: input.spaceId,
    runKey: buildKnowledgeRunKey(input.action, input.now),
  });
}

export function buildKnowledgeRebuildEmbeddingsContinuationJobId(input: {
  workspaceId: string;
  spaceId: string;
  afterChunkId: string;
}): string {
  const cursorKey = createHash('sha256')
    .update(input.afterChunkId)
    .digest('hex');
  return [
    'knowledge-rebuild-embeddings',
    input.workspaceId,
    input.spaceId,
    cursorKey,
  ].join('__');
}

export function buildKnowledgeReindexAccessContinuationJobId(input: {
  workspaceId: string;
  spaceId: string;
  afterSourcePageId: string;
}): string {
  const cursorKey = createHash('sha256')
    .update(input.afterSourcePageId)
    .digest('hex');
  return [
    'knowledge-reindex-access',
    input.workspaceId,
    input.spaceId,
    cursorKey,
  ].join('__');
}

export function buildReviewDiscoverJobId(input: {
  workspaceId: string;
  spaceId: string;
}): string {
  return ['review-discover', input.workspaceId, input.spaceId].join('__');
}

export function buildReviewNegotiateJobId(input: {
  workspaceId: string;
  spaceId: string;
  itemId: string;
}): string {
  return [
    'review-negotiate',
    input.workspaceId,
    input.spaceId,
    input.itemId,
  ].join('__');
}

function buildKnowledgeRunKey(label: string, now = Date.now()): string {
  return `${label}-${now.toString(36)}`;
}

export function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function buildKnowledgeJobId(input: {
  prefix: string;
  workspaceId: string;
  spaceId: string;
  runKey?: string;
  now?: number;
}): string {
  const suffix = input.runKey ?? buildKnowledgeRunKey('run', input.now);
  return [input.prefix, input.workspaceId, input.spaceId, suffix].join('__');
}
