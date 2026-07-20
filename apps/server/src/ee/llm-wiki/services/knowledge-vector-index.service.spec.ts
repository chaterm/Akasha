import { KnowledgeVectorIndexService } from './knowledge-vector-index.service';

describe('KnowledgeVectorIndexService', () => {
  it('rejects unsafe profiles and invalid dimensions before executing SQL', async () => {
    const service = serviceWithExecutor(jest.fn());

    await expect(
      service.ensureProfileIndex({ profile: "abc'; DROP TABLE pages", dimensions: 3 }),
    ).rejects.toThrow('profile');
    await expect(
      service.ensureProfileIndex({ profile: 'a'.repeat(64), dimensions: 0 }),
    ).rejects.toThrow('dimensions');
    await expect(
      service.ensureProfileIndex({ profile: 'a'.repeat(64), dimensions: 3.5 }),
    ).rejects.toThrow('dimensions');
  });

  it('uses exact search when dimensions exceed vector HNSW support', async () => {
    const execute = jest.fn();
    const service = serviceWithExecutor(execute);

    await expect(
      service.ensureProfileIndex({ profile: 'b'.repeat(64), dimensions: 2001 }),
    ).resolves.toBe('exact-only');
    expect(execute).not.toHaveBeenCalled();
  });

  it('creates a profile-scoped expression index with safe identifiers', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithExecutor(execute);

    await expect(
      service.ensureProfileIndex({ profile: 'c'.repeat(64), dimensions: 1024 }),
    ).resolves.toBe('created');

    const ddl = execute.mock.calls[1][0] as string;
    expect(ddl).toContain('idx_kc_hnsw_cccccccccccc_1024');
    expect(ddl).toContain('embedding::vector(1024)');
    expect(ddl).toContain(`embedding_profile = '${'c'.repeat(64)}'`);
    expect(ddl).toContain('embedding_dimensions = 1024');
  });

  it('returns exists without issuing DDL for an existing profile index', async () => {
    const execute = jest.fn().mockResolvedValue({ rows: [{ exists: true }] });
    const service = serviceWithExecutor(execute);

    await expect(
      service.ensureProfileIndex({ profile: 'd'.repeat(64), dimensions: 768 }),
    ).resolves.toBe('exists');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('coalesces duplicate concurrent index requests', async () => {
    let release: (value: { rows: Array<{ exists: boolean }> }) => void;
    const pending = new Promise<{ rows: Array<{ exists: boolean }> }>((resolve) => {
      release = resolve;
    });
    const execute = jest
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ rows: [] });
    const service = serviceWithExecutor(execute);
    const input = { profile: 'e'.repeat(64), dimensions: 1536 };

    const first = service.ensureProfileIndex(input);
    const second = service.ensureProfileIndex(input);
    release!({ rows: [{ exists: false }] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      'created',
      'created',
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

function serviceWithExecutor(execute: jest.Mock): KnowledgeVectorIndexService {
  class TestService extends KnowledgeVectorIndexService {
    protected executeStatement(statement: string) {
      return execute(statement);
    }
  }

  return new TestService({} as never);
}
