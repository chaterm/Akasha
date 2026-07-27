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
});
