export function reconcileRunTargetScope(input: {
  runTargetSourcePageIds: string[] | null;
  requestTargetSourcePageIds: string[] | undefined;
}): { changed: boolean; targetSourcePageIds: string[] | null } {
  const runTarget = input.runTargetSourcePageIds;
  const requestTarget = input.requestTargetSourcePageIds;
  const requestIsFullSpace = !requestTarget || requestTarget.length === 0;
  if (runTarget === null) {
    return { changed: false, targetSourcePageIds: null };
  }
  if (requestIsFullSpace) {
    return { changed: true, targetSourcePageIds: null };
  }
  const union = [...new Set([...runTarget, ...requestTarget!])];
  const changed = union.length !== runTarget.length;
  return { changed, targetSourcePageIds: union };
}

export function reconcileFollowUpTargetScope(input: {
  followUpTargetSourcePageIds: string[] | null;
  requestTargetSourcePageIds: string[] | undefined;
  rerunAlreadyRequested: boolean;
}): { changed: boolean; targetSourcePageIds: string[] | null } {
  if (
    !input.rerunAlreadyRequested &&
    input.requestTargetSourcePageIds?.length
  ) {
    return {
      changed: true,
      targetSourcePageIds: [...new Set(input.requestTargetSourcePageIds)],
    };
  }
  return reconcileRunTargetScope({
    runTargetSourcePageIds: input.followUpTargetSourcePageIds,
    requestTargetSourcePageIds: input.requestTargetSourcePageIds,
  });
}

export function normalizeTargetSourcePageIds(
  value: string[] | undefined,
): string[] | null {
  if (!value) return null;
  const unique = [...new Set(value.filter((id) => id.length > 0))];
  return unique.length > 0 ? unique : null;
}

export function parseTargetSourcePageIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => typeof id === 'string');
  return ids.length > 0 ? ids : null;
}
