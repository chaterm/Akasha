const ENV_KEYS = [
  'DATABASE_MAX_POOL',
  'KNOWLEDGE_SPACE_CONCURRENCY',
  'KNOWLEDGE_IMAGE_CONCURRENCY',
  'KNOWLEDGE_SPACE_SLICE_MAX_PAGES',
  'KNOWLEDGE_SPACE_SLICE_MAX_MS',
  'KNOWLEDGE_SPACE_HEARTBEAT_MS',
  'KNOWLEDGE_SPACE_LEASE_TTL_MS',
] as const;

describe('knowledge worker settings', () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('freezes safe defaults at module evaluation time', () => {
    const module = loadSettings();

    expect(module.KNOWLEDGE_WORKER_SETTINGS).toEqual({
      databaseMaxPool: 25,
      spaceConcurrency: 10,
      imageConcurrency: 5,
      sliceMaxPages: 5,
      sliceMaxMs: 300_000,
      heartbeatMs: 30_000,
      executionLeaseTtlMs: 180_000,
    });
    expect(Object.isFrozen(module.KNOWLEDGE_WORKER_SETTINGS)).toBe(true);
    expect(module.KNOWLEDGE_SPACE_WORKER_OPTIONS).toEqual({
      concurrency: 10,
      lockDuration: 120_000,
      stalledInterval: 30_000,
      maxStalledCount: 2,
    });
    expect(module.KNOWLEDGE_IMAGE_WORKER_OPTIONS).toEqual({
      concurrency: 5,
      lockDuration: 120_000,
      stalledInterval: 30_000,
      maxStalledCount: 2,
    });
    expect(module.KNOWLEDGE_SPACE_WORKER_OPTIONS).not.toHaveProperty(
      'lockRenewTime',
    );
  });

  it('reads non-default values before decorators import the module', () => {
    Object.assign(process.env, {
      DATABASE_MAX_POOL: '22',
      KNOWLEDGE_SPACE_CONCURRENCY: '7',
      KNOWLEDGE_IMAGE_CONCURRENCY: '5',
      KNOWLEDGE_SPACE_SLICE_MAX_PAGES: '9',
      KNOWLEDGE_SPACE_SLICE_MAX_MS: '420000',
      KNOWLEDGE_SPACE_HEARTBEAT_MS: '20000',
      KNOWLEDGE_SPACE_LEASE_TTL_MS: '150000',
    });

    expect(loadSettings().KNOWLEDGE_WORKER_SETTINGS).toEqual({
      databaseMaxPool: 22,
      spaceConcurrency: 7,
      imageConcurrency: 5,
      sliceMaxPages: 9,
      sliceMaxMs: 420_000,
      heartbeatMs: 20_000,
      executionLeaseTtlMs: 150_000,
    });
  });

  it.each([
    ['KNOWLEDGE_SPACE_CONCURRENCY', '0'],
    ['KNOWLEDGE_SPACE_CONCURRENCY', '11'],
    ['KNOWLEDGE_SPACE_CONCURRENCY', '1.5'],
    ['KNOWLEDGE_IMAGE_CONCURRENCY', '0'],
    ['KNOWLEDGE_IMAGE_CONCURRENCY', '11'],
    ['KNOWLEDGE_SPACE_SLICE_MAX_PAGES', '51'],
    ['KNOWLEDGE_SPACE_SLICE_MAX_MS', '59999'],
    ['KNOWLEDGE_SPACE_HEARTBEAT_MS', '60001'],
    ['KNOWLEDGE_SPACE_LEASE_TTL_MS', '119999'],
  ])('fails module loading for invalid %s=%s', (key, value) => {
    process.env[key] = value;
    expect(() => loadSettings()).toThrow(key);
  });

  it('rejects a heartbeat that is not shorter than its execution lease', () => {
    process.env.KNOWLEDGE_SPACE_HEARTBEAT_MS = '120000';
    process.env.KNOWLEDGE_SPACE_LEASE_TTL_MS = '120000';

    expect(() => loadSettings()).toThrow('KNOWLEDGE_SPACE_HEARTBEAT_MS');
  });

  it('rejects worker concurrency that exceeds the local connection budget', () => {
    process.env.DATABASE_MAX_POOL = '20';
    process.env.KNOWLEDGE_SPACE_CONCURRENCY = '10';
    process.env.KNOWLEDGE_IMAGE_CONCURRENCY = '5';

    expect(() => loadSettings()).toThrow(
      'DATABASE_MAX_POOL must be at least KNOWLEDGE_SPACE_CONCURRENCY + KNOWLEDGE_IMAGE_CONCURRENCY + 10',
    );
  });

  it('keeps image attempts and backoff explicit on every image job', () => {
    expect(loadSettings().knowledgeImageJobOptions('image-job-1')).toEqual({
      jobId: 'image-job-1',
      attempts: 3,
      backoff: { type: 'exponential', delay: 31_000 },
    });
  });
});

function loadSettings(): typeof import('./knowledge-worker-settings') {
  let loaded: typeof import('./knowledge-worker-settings');
  jest.isolateModules(() => {
    loaded = require('./knowledge-worker-settings');
  });
  return loaded!;
}
