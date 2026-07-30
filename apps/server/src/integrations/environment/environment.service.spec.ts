import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EnvironmentService } from './environment.service';

describe('EnvironmentService', () => {
  let service: EnvironmentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnvironmentService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, fallback: unknown) => fallback),
          },
        },
      ],
    }).compile();

    service = module.get<EnvironmentService>(EnvironmentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('defaults the knowledge compiler timeout to two minutes', () => {
    expect(service.getKnowledgeCompilerTimeoutMs()).toBe(120_000);
  });

  it('reads a configured knowledge compiler timeout', () => {
    const configured = new EnvironmentService({
      get: jest.fn(() => '45000'),
    } as unknown as ConfigService);

    expect(configured.getKnowledgeCompilerTimeoutMs()).toBe(45_000);
  });

  it('defaults the AI chat input safeguard to 700K characters', () => {
    expect(service.getAiChatMaxInputChars()).toBe(700_000);
  });

  it('reads a configured AI chat input safeguard', () => {
    const configured = new EnvironmentService({
      get: jest.fn((key: string, fallback: unknown) =>
        key === 'AI_CHAT_MAX_INPUT_CHARS' ? '500000' : fallback,
      ),
    } as unknown as ConfigService);

    expect(configured.getAiChatMaxInputChars()).toBe(500_000);
  });

  it('rejects an AI chat input safeguard too small for the fixed prompt', () => {
    const configured = new EnvironmentService({
      get: jest.fn((key: string, fallback: unknown) =>
        key === 'AI_CHAT_MAX_INPUT_CHARS' ? '1' : fallback,
      ),
    } as unknown as ConfigService);

    expect(configured.getAiChatMaxInputChars()).toBe(700_000);
  });

  it('defaults the image understanding model and timeout', () => {
    expect(service.getAiVisionModel()).toBe('qwen3.7-plus');
    expect(service.getKnowledgeImageTimeoutMs()).toBe(120_000);
  });

  it('reads configured image understanding settings', () => {
    const configured = new EnvironmentService({
      get: jest.fn((key: string) => {
        if (key === 'AI_VISION_MODEL') return 'custom-vision-model';
        if (key === 'KNOWLEDGE_IMAGE_TIMEOUT_MS') return '45000';
        return undefined;
      }),
    } as unknown as ConfigService);

    expect(configured.getAiVisionModel()).toBe('custom-vision-model');
    expect(configured.getKnowledgeImageTimeoutMs()).toBe(45_000);
  });
});
