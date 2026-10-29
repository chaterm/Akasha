import { embed, generateText } from 'ai';
import { AiModelConfigTestService } from './ai-model-config-test.service';
import { AiModelConfigService } from './ai-model-config.service';
import {
  createEmbeddingModelFromConfig,
  createLanguageModelFromConfig,
} from './ai-model-factory';

jest.mock('ai', () => ({
  embed: jest.fn(),
  generateText: jest.fn(),
}));

jest.mock('./ai-model-factory', () => ({
  createLanguageModelFromConfig: jest.fn(),
  createEmbeddingModelFromConfig: jest.fn(),
}));

describe('AiModelConfigTestService', () => {
  let configService: { getResolvedConfig: jest.Mock };
  let service: AiModelConfigTestService;

  const input = {
    provider: 'openai-compatible',
    model: 'qwen-max',
    baseUrl: 'https://api.test/v1',
    apiKey: 'form-key',
  };

  beforeEach(() => {
    jest.resetAllMocks();
    configService = { getResolvedConfig: jest.fn() };
    service = new AiModelConfigTestService(
      configService as unknown as AiModelConfigService,
    );
  });

  it('returns ok with latency for a successful text feature test', async () => {
    (createLanguageModelFromConfig as jest.Mock).mockReturnValue('lang-model');
    (generateText as jest.Mock).mockResolvedValue({ text: 'ok' });

    const result = await service.testConfig('answer', input);

    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'lang-model',
        prompt: 'ping',
        providerOptions: {
          akashaConfigTest: {
            chat_template_kwargs: { enable_thinking: false },
          },
        },
      }),
    );
    expect(configService.getResolvedConfig).not.toHaveBeenCalled();
  });

  it('tests the embedding feature with the embed call', async () => {
    (createEmbeddingModelFromConfig as jest.Mock).mockReturnValue(
      'embed-model',
    );
    (embed as jest.Mock).mockResolvedValue({ embedding: [0.1] });

    const result = await service.testConfig('embedding', input);

    expect(result.ok).toBe(true);
    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'embed-model', value: 'ping' }),
    );
  });

  it('falls back to the stored api key when the form key is blank', async () => {
    configService.getResolvedConfig.mockResolvedValue({ apiKey: 'stored-key' });
    (createLanguageModelFromConfig as jest.Mock).mockReturnValue('lang-model');
    (generateText as jest.Mock).mockResolvedValue({ text: 'ok' });

    await service.testConfig('answer', { ...input, apiKey: '' });

    expect(configService.getResolvedConfig).toHaveBeenCalledWith('answer');
    expect(createLanguageModelFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'stored-key' }),
      'akashaConfigTest',
    );
  });

  it('returns not_configured when the model cannot be built', async () => {
    (createLanguageModelFromConfig as jest.Mock).mockReturnValue(undefined);

    const result = await service.testConfig('answer', input);

    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'not_configured' }),
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it('classifies a 429 as rate_limited', async () => {
    (createLanguageModelFromConfig as jest.Mock).mockReturnValue('lang-model');
    (generateText as jest.Mock).mockRejectedValue({ statusCode: 429 });

    const result = await service.testConfig('compiler', input);

    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'rate_limited' }),
    );
  });

  it('classifies 401/403 as auth_failed', async () => {
    (createLanguageModelFromConfig as jest.Mock).mockReturnValue('lang-model');
    (generateText as jest.Mock).mockRejectedValue({ statusCode: 401 });

    const result = await service.testConfig('image', input);

    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: 'auth_failed' }),
    );
  });

  it('classifies other errors as provider_error with the message', async () => {
    (createLanguageModelFromConfig as jest.Mock).mockReturnValue('lang-model');
    (generateText as jest.Mock).mockRejectedValue(
      new Error('ECONNREFUSED upstream'),
    );

    const result = await service.testConfig('answer', input);

    expect(result.ok).toBe(false);
    expect(result.code).toBe('provider_error');
    expect(result.message).toContain('ECONNREFUSED');
  });
});
