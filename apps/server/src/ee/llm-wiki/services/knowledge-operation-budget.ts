export const MAX_KNOWLEDGE_ARTIFACTS_PER_PAGE = 20;
export const MAX_KNOWLEDGE_MATERIALIZATIONS_PER_PAGE = 8;
export const MAX_KNOWLEDGE_CHUNKS_PER_PAGE = 200;
export const DEFAULT_KNOWLEDGE_SPACE_SLOT_WORST_CASE_MS =
  300_000 + 900_000 + 300_000 + 5_000;

export type KnowledgeComplexityLimitKind =
  | 'artifacts'
  | 'materializations'
  | 'chunks';

export class KnowledgeComplexityLimitError extends Error {
  readonly code = 'page_complexity_limit';
  readonly retryable = false;

  constructor(
    readonly limitKind: KnowledgeComplexityLimitKind,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`Knowledge page exceeded the ${limitKind} limit.`);
    this.name = 'KnowledgeComplexityLimitError';
  }
}

export class KnowledgeOperationBudget {
  readonly signal?: AbortSignal;
  private materializationCount = 0;

  constructor(input: { signal?: AbortSignal } = {}) {
    this.signal = input.signal;
  }

  throwIfAborted(): void {
    this.signal?.throwIfAborted();
  }

  assertArtifactCount(count: number): void {
    assertLimit('artifacts', count, MAX_KNOWLEDGE_ARTIFACTS_PER_PAGE);
  }

  consumeMaterialization(): void {
    this.materializationCount += 1;
    assertLimit(
      'materializations',
      this.materializationCount,
      MAX_KNOWLEDGE_MATERIALIZATIONS_PER_PAGE,
    );
  }

  assertChunkCount(count: number): void {
    assertLimit('chunks', count, MAX_KNOWLEDGE_CHUNKS_PER_PAGE);
  }
}

export function createBoundedAbortSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  const timeout = setTimeout(() => {
    const error = new Error(
      `Knowledge operation timed out after ${timeoutMs}ms.`,
    );
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);
  timeout.unref?.();

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

export async function mapKnowledgeOperations<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => Promise<R>,
  options: { batchSize?: number; concurrency?: number } = {},
): Promise<R[]> {
  const batchSize = options.batchSize ?? 50;
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(
      'knowledge operation batch size must be a positive integer',
    );
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      'knowledge operation concurrency must be a positive integer',
    );
  }

  const results = new Array<R>(values.length);
  for (let offset = 0; offset < values.length; offset += batchSize) {
    const batch = values.slice(offset, offset + batchSize);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, batch.length) },
      async () => {
        while (cursor < batch.length) {
          const batchIndex = cursor;
          cursor += 1;
          const index = offset + batchIndex;
          results[index] = await mapper(batch[batchIndex], index);
        }
      },
    );
    await Promise.all(workers);
  }
  return results;
}

function assertLimit(
  limitKind: KnowledgeComplexityLimitKind,
  actual: number,
  limit: number,
): void {
  if (actual > limit) {
    throw new KnowledgeComplexityLimitError(limitKind, limit, actual);
  }
}
