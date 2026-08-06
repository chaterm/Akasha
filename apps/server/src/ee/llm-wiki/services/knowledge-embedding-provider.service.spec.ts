import { embed } from 'ai';
import {
  buildKnowledgeEmbeddingProfile,
  ConfiguredKnowledgeEmbeddingProvider,
} from './knowledge-embedding-provider.service';

jest.mock('ai', () => ({ embed: jest.fn() }));
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
    (embed as jest.Mock).mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
    const service = new ConfiguredKnowledgeEmbeddingProvider(
      environment({ embeddingDimensions: 3072 }) as never,
    );

    await expect(service.embedQuery('Akasha wiki')).resolves.toEqual({
      vector: [0.1, 0.2, 0.3],
      profile: buildKnowledgeEmbeddingProfile({
        driver: 'openai-compatible',
        baseUrl: 'https://llm.example/v1',
        model: 'bge-m3',
        dimensions: 3,
      }),
      model: 'bge-m3',
      dimensions: 3,
    });
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
  return {
    getAiDriver: jest.fn(() =>
      Object.prototype.hasOwnProperty.call(input, 'driver')
        ? input.driver
        : 'openai-compatible',
    ),
    getAiEmbeddingModel: jest.fn(() => 'bge-m3'),
    getAiEmbeddingDimension: jest.fn(() => input.embeddingDimensions),
    getOpenAiApiKey: jest.fn(() => 'must-not-affect-profile'),
    getOpenAiApiUrl: jest.fn(() => 'https://llm.example/v1/'),
  };
}
