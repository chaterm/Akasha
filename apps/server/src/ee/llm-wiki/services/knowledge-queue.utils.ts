import { KnowledgeAdminSpaceAction } from '../types/knowledge-queue.types';

export const KNOWLEDGE_COMPILE_DELAY_MS = 5000;

export function buildKnowledgeCompileJobId(input: {
  workspaceId: string;
  spaceId: string;
  runKey?: string;
  now?: number;
}): string {
  return buildKnowledgeJobId({
    prefix: 'knowledge-compile-space',
    workspaceId: input.workspaceId,
    spaceId: input.spaceId,
    runKey: input.runKey,
    now: input.now,
  });
}

export function buildKnowledgeCompilePageJobId(input: {
  workspaceId: string;
  spaceId: string;
  sourcePageId: string;
  runKey?: string;
  now?: number;
}): string {
  return [
    'knowledge-compile-pages',
    input.workspaceId,
    input.spaceId,
    input.sourcePageId,
    input.runKey ?? buildKnowledgeRunKey('run', input.now),
  ].join('__');
}

export function buildKnowledgeAggregateSpaceJobId(input: {
  runId: string;
}): string {
  return ['knowledge-aggregate-space', input.runId].join('__');
}

export function buildKnowledgeAdminActionJobId(input: {
  action: KnowledgeAdminSpaceAction;
  workspaceId: string;
  spaceId: string;
  now?: number;
}): string {
  const prefix =
    input.action === 'reindex_access'
      ? 'knowledge-reindex-access'
      : input.action === 'mark_stale'
        ? 'knowledge-mark-stale'
        : 'knowledge-compile-space';

  return buildKnowledgeJobId({
    prefix,
    workspaceId: input.workspaceId,
    spaceId: input.spaceId,
    runKey: buildKnowledgeRunKey(input.action, input.now),
  });
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

export function buildKnowledgeRunKey(label: string, now = Date.now()): string {
  return `${label}-${now.toString(36)}`;
}

export function buildKnowledgeCompileCoalesceKey(
  now = Date.now(),
  windowMs = KNOWLEDGE_COMPILE_DELAY_MS,
): string {
  return `page-update-${Math.floor(now / windowMs)}`;
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
