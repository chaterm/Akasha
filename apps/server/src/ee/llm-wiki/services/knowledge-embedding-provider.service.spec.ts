import { embed, embedMany } from 'ai';
import {
  buildKnowledgeEmbeddingProfile,
  ConfiguredKnowledgeEmbeddingProvider,
} from './knowledge-embedding-provider.service';

jest.mock('ai', () => ({ embed: jest.fn(), embedMany: jest.fn() }));
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => ({ embeddingModel: jest.fn(() => ({})) })),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(() => ({
    embeddingModel: jest.fn(() => ({})),
  })),
}));

describe('ConfiguredKnowledgeEmbeddingProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds a deterministic non-secret profile from provider identity', () => {
    const first = buildKnowledgeEmbeddingProfile({
      driver: 'openai-compatible',
      baseUrl: 'https://llm.example/v1/',
      model: 'bge-m3',
      dimensions: 3,
    });
    const same = buildKnowledgeEmbeddingProfile({
      driver: ' OPENAI-COMPATIBLE ',
      baseUrl: 'https://llm.example/v1',
      model: ' bge-m3 ',
      dimensions: 3,
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toBe(first);
    expect(
      buildKnowledgeEmbeddingProfile({
        driver: 'openai-compatible',
        baseUrl: 'https://llm.example/v1',
        model: 'text-embedding-3-large',
        dimensions: 3,
      }),
    ).not.toBe(first);
    expect(
      buildKnowledgeEmbeddingProfile({
        driver: 'openai-compatible',
        baseUrl: 'https://llm.example/v1',
        model: 'bge-m3',
        dimensions: 4,
      }),
    ).not.toBe(first);
  });

  it('returns the observed vector dimensions rather than a configured hint', async () => {
    (embed as jest.Mock).mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
      usage: { tokens: 7 },
    });
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment({ embeddingDimensions: 3072 }) as never,
    );

    await expect(service.embedQuery('Akasha wiki')).resolves.toEqual(
      expect.objectContaining({
        vector: [0.1, 0.2, 0.3],
        profile: buildKnowledgeEmbeddingProfile({
          driver: 'openai-compatible',
          baseUrl: 'https://llm.example/v1',
          model: 'bge-m3',
          dimensions: 3,
        }),
        model: 'bge-m3',
        dimensions: 3,
        totalTokens: 7,
        durationMs: expect.any(Number),
      }),
    );
  });

  it('embeds many table rows in one provider-level batch', async () => {
    (embedMany as jest.Mock).mockResolvedValue({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      usage: { tokens: 9 },
    });
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment() as never,
    );

    const result = await service.embedManyRequired(['row one', 'row two']);

    expect(embedMany).toHaveBeenCalledWith(
      expect.objectContaining({
        values: ['row one', 'row two'],
        maxParallelCalls: 2,
      }),
    );
    expect(result.map((embedding) => embedding.vector)).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(result.map((embedding) => embedding.totalTokens)).toEqual([5, 4]);
    expect(result.map((embedding) => embedding.durationMs)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('enforces Bailian text-embedding-v4 10-input request limit', async () => {
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment() as never,
    );

    await expect(
      service.embedManyRequired(Array.from({ length: 11 }, () => 'row')),
    ).rejects.toMatchObject({
      code: 'embedding_invalid_input',
      retryable: false,
    });
    expect(embedMany).not.toHaveBeenCalled();
  });

  it('reports Bailian per-input 8,192-token rejection without treating it as a batch-total limit', async () => {
    (embedMany as jest.Mock).mockRejectedValue(
      Object.assign(new Error('input token length exceeds maximum limit'), {
        statusCode: 400,
      }),
    );
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment() as never,
    );

    await expect(
      service.embedManyRequired(['provider-sized input']),
    ).rejects.toMatchObject({
      code: 'embedding_input_too_large',
      retryable: false,
    });
  });

  it('applies the 8,192 limit to each input rather than the batch total', async () => {
    const texts = Array.from(
      { length: 10 },
      (_, index) => `${index}:${'x'.repeat(999)}`,
    );
    (embedMany as jest.Mock).mockResolvedValue({
      embeddings: texts.map(() => [0.1, 0.2]),
    });
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment() as never,
    );

    await expect(service.embedManyRequired(texts)).resolves.toHaveLength(10);
    expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeGreaterThan(
      8_192,
    );
    expect(embedMany).toHaveBeenCalledWith(
      expect.objectContaining({ values: texts }),
    );
  });

  it('returns null for empty input and provider failures', async () => {
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment() as never,
    );

    await expect(service.embedQuery('  ')).resolves.toBeNull();
    expect(embed).not.toHaveBeenCalled();

    (embed as jest.Mock).mockRejectedValue(new Error('provider unavailable'));
    await expect(service.embedQuery('Akasha wiki')).resolves.toBeNull();
  });

  it('throws a typed retryable error when required embedding fails', async () => {
    (embed as jest.Mock).mockRejectedValue(
      Object.assign(new Error('rate limited'), { statusCode: 429 }),
    );
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment() as never,
    );

    await expect(service.embedRequired('Akasha wiki')).rejects.toMatchObject({
      code: 'embedding_rate_limited',
      retryable: true,
      message: 'Knowledge embedding provider rate limit was reached.',
    });
  });

  it('rejects invalid required vectors instead of returning success', async () => {
    (embed as jest.Mock).mockResolvedValue({ embedding: [Number.NaN] });
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment() as never,
    );

    await expect(service.embedRequired('Akasha wiki')).rejects.toMatchObject({
      code: 'embedding_invalid_vector',
      retryable: true,
    });
  });

  it('reports missing required embedding configuration as non-retryable', async () => {
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment({ driver: undefined }) as never,
    );

    await expect(service.embedRequired('Akasha wiki')).rejects.toMatchObject({
      code: 'embedding_not_configured',
      retryable: false,
    });
    expect(embed).not.toHaveBeenCalled();
  });

  it('combines the parent signal with a 30 second request timeout', async () => {
    (embed as jest.Mock).mockResolvedValue({ embedding: [0.1] });
    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    const parent = new AbortController();
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment() as never,
    );

    await service.embedQuery('Akasha wiki', { abortSignal: parent.signal });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    timeoutSpy.mockRestore();
  });
});

function environment(
  input: { embeddingDimensions?: number; driver?: string } = {
    driver: 'openai-compatible',
  },
) {
  const driver = Object.prototype.hasOwnProperty.call(input, 'driver')
    ? input.driver
    : 'openai-compatible';
  return {
    getResolvedConfig: jest.fn(async () => ({
      driver,
      model: 'bge-m3',
      apiKey: 'must-not-affect-profile',
      baseUrl: 'https://llm.example/v1/',
      parameters: { dimension: input.embeddingDimensions },
      fromDatabase: false,
    })),
    invalidate: jest.fn(),
  };
}
