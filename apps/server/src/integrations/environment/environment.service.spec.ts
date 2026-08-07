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

  it('defaults the dedicated knowledge compiler profile', () => {
    expect(service.getKnowledgeCompilerModel()).toBe('qwen3.8-max');
    expect(service.getKnowledgeCompilerThinking()).toBe(false);
    expect(service.getKnowledgeCompilerMaxOutputTokens()).toBe(16_384);
    expect(service.getKnowledgeImageMergeMaxOutputTokens()).toBe(8_192);
    expect(service.getKnowledgeCompilerTimeoutMs()).toBe(300_000);
  });

  it('defaults database and compilation execution limits', () => {
    expect(service.getDatabaseMaxPool()).toBe(25);
    expect(service.getDatabaseStatementTimeoutMs()).toBe(30_000);
    expect(service.getKnowledgePageDeadlineMs()).toBe(900_000);
    expect(service.getKnowledgeAggregateDeadlineMs()).toBe(300_000);
    expect(service.getKnowledgeImageJobDeadlineMs()).toBe(180_000);
    expect(service.getKnowledgeSpaceConcurrency()).toBe(10);
    expect(service.getKnowledgeImageConcurrency()).toBe(5);
    expect(service.getKnowledgeSpaceSliceMaxPages()).toBe(5);
    expect(service.getKnowledgeSpaceSliceMaxMs()).toBe(300_000);
    expect(service.getKnowledgeSpaceHeartbeatMs()).toBe(30_000);
    expect(service.getKnowledgeSpaceLeaseTtlMs()).toBe(180_000);
  });

  it('reads configured database and compilation execution limits', () => {
    const configuredValues: Record<string, string> = {
      DATABASE_MAX_POOL: '40',
      DATABASE_STATEMENT_TIMEOUT_MS: '45000',
      KNOWLEDGE_PAGE_DEADLINE_MS: '600000',
      KNOWLEDGE_AGGREGATE_DEADLINE_MS: '360000',
      KNOWLEDGE_IMAGE_JOB_DEADLINE_MS: '240000',
      KNOWLEDGE_SPACE_CONCURRENCY: '7',
      KNOWLEDGE_IMAGE_CONCURRENCY: '4',
      KNOWLEDGE_SPACE_SLICE_MAX_PAGES: '8',
      KNOWLEDGE_SPACE_SLICE_MAX_MS: '420000',
      KNOWLEDGE_SPACE_HEARTBEAT_MS: '20000',
      KNOWLEDGE_SPACE_LEASE_TTL_MS: '150000',
      KNOWLEDGE_COMPILER_MODEL: 'compiler-model',
      KNOWLEDGE_COMPILER_THINKING: 'false',
      KNOWLEDGE_COMPILER_MAX_OUTPUT_TOKENS: '12000',
      KNOWLEDGE_IMAGE_MERGE_MAX_OUTPUT_TOKENS: '6000',
      KNOWLEDGE_COMPILER_TIMEOUT_MS: '45000',
    };
    const configured = new EnvironmentService({
      get: jest.fn((key: string, fallback: unknown) =>
        key in configuredValues ? configuredValues[key] : fallback,
      ),
    } as unknown as ConfigService);

    expect(configured.getDatabaseMaxPool()).toBe(40);
    expect(configured.getDatabaseStatementTimeoutMs()).toBe(45_000);
    expect(configured.getKnowledgePageDeadlineMs()).toBe(600_000);
    expect(configured.getKnowledgeAggregateDeadlineMs()).toBe(360_000);
    expect(configured.getKnowledgeImageJobDeadlineMs()).toBe(240_000);
    expect(configured.getKnowledgeSpaceConcurrency()).toBe(7);
    expect(configured.getKnowledgeImageConcurrency()).toBe(4);
    expect(configured.getKnowledgeSpaceSliceMaxPages()).toBe(8);
    expect(configured.getKnowledgeSpaceSliceMaxMs()).toBe(420_000);
    expect(configured.getKnowledgeSpaceHeartbeatMs()).toBe(20_000);
    expect(configured.getKnowledgeSpaceLeaseTtlMs()).toBe(150_000);
    expect(configured.getKnowledgeCompilerModel()).toBe('compiler-model');
    expect(configured.getKnowledgeCompilerThinking()).toBe(false);
    expect(configured.getKnowledgeCompilerMaxOutputTokens()).toBe(12_000);
    expect(configured.getKnowledgeImageMergeMaxOutputTokens()).toBe(6_000);
    expect(configured.getKnowledgeCompilerTimeoutMs()).toBe(45_000);
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
