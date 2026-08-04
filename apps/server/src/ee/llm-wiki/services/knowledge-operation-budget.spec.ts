import {
  KnowledgeComplexityLimitError,
  KnowledgeOperationBudget,
  DEFAULT_KNOWLEDGE_SPACE_SLOT_WORST_CASE_MS,
  createBoundedAbortSignal,
  mapKnowledgeOperations,
} from './knowledge-operation-budget';

describe('knowledge operation budget', () => {
  it('keeps the default space slot worst case at 1,505 seconds', () => {
    expect(DEFAULT_KNOWLEDGE_SPACE_SLOT_WORST_CASE_MS).toBe(1_505_000);
  });

  it('combines a parent cancellation with a shorter operation timeout', () => {
    jest.useFakeTimers();
    const parent = new AbortController();
    const bounded = createBoundedAbortSignal(parent.signal, 30_000);

    expect(bounded.signal.aborted).toBe(false);
    parent.abort(new Error('page deadline'));

    expect(bounded.signal.aborted).toBe(true);
    expect(bounded.signal.reason).toEqual(new Error('page deadline'));
    bounded.dispose();
    jest.useRealTimers();
  });

  it('aborts an operation at its own hard timeout without a Promise.race', () => {
    jest.useFakeTimers();
    const bounded = createBoundedAbortSignal(undefined, 30_000);

    jest.advanceTimersByTime(30_000);

    expect(bounded.signal.aborted).toBe(true);
    expect(bounded.signal.reason).toMatchObject({ name: 'TimeoutError' });
    bounded.dispose();
    jest.useRealTimers();
  });

  it.each([
    ['artifacts', () => new KnowledgeOperationBudget().assertArtifactCount(21)],
    [
      'materializations',
      () => {
        const budget = new KnowledgeOperationBudget();
        for (let index = 0; index < 9; index += 1) {
          budget.consumeMaterialization();
        }
      },
    ],
    ['chunks', () => new KnowledgeOperationBudget().assertChunkCount(201)],
  ])('rejects page complexity above the %s limit', (_name, operation) => {
    expect(operation).toThrow(
      expect.objectContaining<Partial<KnowledgeComplexityLimitError>>({
        code: 'page_complexity_limit',
        retryable: false,
      }),
    );
  });

  it('processes at most 50 entries per batch with concurrency 2', async () => {
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];

    const results = await mapKnowledgeOperations(
      Array.from({ length: 120 }, (_, index) => index),
      async (value) => {
        started.push(value);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return value * 2;
      },
    );

    expect(maxActive).toBe(2);
    expect(started).toEqual(Array.from({ length: 120 }, (_, index) => index));
    expect(results).toEqual(
      Array.from({ length: 120 }, (_, index) => index * 2),
    );
  });
});
