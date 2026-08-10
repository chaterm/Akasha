import { AiModelConfigService } from './ai-model-config.service';
import { AiModelConfigRepo } from '../../../database/repos/llm-wiki/ai-model-config.repo';
import { AiConfigSecretService } from './ai-config-secret.service';
import { AiModelConfig } from '@akasha/db/types/entity.types';

function buildRepo(row: AiModelConfig | undefined) {
  return {
    findByFeature: jest.fn().mockResolvedValue(row),
  } as unknown as AiModelConfigRepo;
}

const secretService = {
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => v.replace(/^enc\(|\)$/g, ''),
} as unknown as AiConfigSecretService;

describe('AiModelConfigService', () => {
  it('returns unconfigured config when no DB row exists', async () => {
    const service = new AiModelConfigService(buildRepo(undefined), secretService);

    const resolved = await service.getResolvedConfig('compiler');

    expect(resolved.fromDatabase).toBe(false);
    expect(resolved.driver).toBeUndefined();
    expect(resolved.model).toBeUndefined();
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.baseUrl).toBeUndefined();
    expect(resolved.parameters).toEqual({});
  });

  it('uses DB row and decrypts the API key when configured', async () => {
    const row = {
      feature: 'compiler',
      provider: 'openai-compatible',
      model: 'gpt-5.6-luna',
      baseUrl: 'https://tokencheap.io/v1',
      apiKeyEncrypted: 'enc(sk-db-key)',
      parameters: {},
    } as unknown as AiModelConfig;
    const service = new AiModelConfigService(buildRepo(row), secretService);

    const resolved = await service.getResolvedConfig('compiler');

    expect(resolved.fromDatabase).toBe(true);
    expect(resolved.driver).toBe('openai-compatible');
    expect(resolved.model).toBe('gpt-5.6-luna');
    expect(resolved.apiKey).toBe('sk-db-key');
    expect(resolved.baseUrl).toBe('https://tokencheap.io/v1');
    expect(resolved.parameters).toEqual({});
  });

  it('does not synthesize API key or base URL when DB row omits them', async () => {
    const row = {
      feature: 'answer',
      provider: 'openai-compatible',
      model: 'qwen-plus',
      baseUrl: null,
      apiKeyEncrypted: null,
      parameters: null,
    } as unknown as AiModelConfig;
    const service = new AiModelConfigService(buildRepo(row), secretService);

    const resolved = await service.getResolvedConfig('answer');

    expect(resolved.model).toBe('qwen-plus');
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.baseUrl).toBeUndefined();
    expect(resolved.parameters).toEqual({});
  });

  it('returns unconfigured config when repo lookup throws', async () => {
    const repo = {
      findByFeature: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as AiModelConfigRepo;
    const service = new AiModelConfigService(repo, secretService);

    const resolved = await service.getResolvedConfig('embedding');

    expect(resolved.fromDatabase).toBe(false);
    expect(resolved.model).toBeUndefined();
    expect(resolved.parameters).toEqual({});
  });

  it('caches results within the TTL (single repo hit)', async () => {
    const repo = buildRepo(undefined);
    const service = new AiModelConfigService(repo, secretService);

    await service.getResolvedConfig('compiler');
    await service.getResolvedConfig('compiler');

    expect(repo.findByFeature).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidate', async () => {
    const repo = buildRepo(undefined);
    const service = new AiModelConfigService(repo, secretService);

    await service.getResolvedConfig('compiler');
    service.invalidate('compiler');
    await service.getResolvedConfig('compiler');

    expect(repo.findByFeature).toHaveBeenCalledTimes(2);
  });

  it('falls back to env key when decryption fails', async () => {
    const row = {
      feature: 'compiler',
      provider: 'openai-compatible',
      model: 'gpt-5.6-luna',
      baseUrl: 'https://tokencheap.io/v1',
      apiKeyEncrypted: 'corrupt',
      parameters: null,
    } as unknown as AiModelConfig;
    const throwingSecret = {
      decrypt: () => {
        throw new Error('bad ciphertext');
      },
    } as unknown as AiConfigSecretService;
    const service = new AiModelConfigService(buildRepo(row), throwingSecret);

    const resolved = await service.getResolvedConfig('compiler');

    expect(resolved.fromDatabase).toBe(true);
    expect(resolved.apiKey).toBeUndefined();
  });
});
