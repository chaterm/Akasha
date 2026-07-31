import { KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS } from './knowledge-queue.utils';

export interface KnowledgeWorkerSettings {
  databaseMaxPool: number;
  spaceConcurrency: number;
  imageConcurrency: number;
  sliceMaxPages: number;
  sliceMaxMs: number;
  heartbeatMs: number;
  executionLeaseTtlMs: number;
}

export function parseKnowledgeWorkerSettings(
  environment: NodeJS.ProcessEnv,
): Readonly<KnowledgeWorkerSettings> {
  const settings = {
    databaseMaxPool: integerSetting(
      environment,
      'DATABASE_MAX_POOL',
      25,
      1,
      100,
    ),
    spaceConcurrency: integerSetting(
      environment,
      'KNOWLEDGE_SPACE_CONCURRENCY',
      10,
      1,
      10,
    ),
    imageConcurrency: integerSetting(
      environment,
      'KNOWLEDGE_IMAGE_CONCURRENCY',
      5,
      1,
      10,
    ),
    sliceMaxPages: integerSetting(
      environment,
      'KNOWLEDGE_SPACE_SLICE_MAX_PAGES',
      5,
      1,
      50,
    ),
    sliceMaxMs: integerSetting(
      environment,
      'KNOWLEDGE_SPACE_SLICE_MAX_MS',
      300_000,
      60_000,
      900_000,
    ),
    heartbeatMs: integerSetting(
      environment,
      'KNOWLEDGE_SPACE_HEARTBEAT_MS',
      30_000,
      10_000,
      60_000,
    ),
    executionLeaseTtlMs: integerSetting(
      environment,
      'KNOWLEDGE_SPACE_LEASE_TTL_MS',
      180_000,
      120_000,
      600_000,
    ),
  };

  if (settings.heartbeatMs >= settings.executionLeaseTtlMs) {
    throw new Error(
      'KNOWLEDGE_SPACE_HEARTBEAT_MS must be less than KNOWLEDGE_SPACE_LEASE_TTL_MS',
    );
  }
  if (
    settings.databaseMaxPool <
    settings.spaceConcurrency + settings.imageConcurrency + 10
  ) {
    throw new Error(
      'DATABASE_MAX_POOL must be at least KNOWLEDGE_SPACE_CONCURRENCY + KNOWLEDGE_IMAGE_CONCURRENCY + 10',
    );
  }

  return Object.freeze(settings);
}

export const KNOWLEDGE_WORKER_SETTINGS = parseKnowledgeWorkerSettings(
  process.env,
);

export const KNOWLEDGE_SPACE_WORKER_OPTIONS = Object.freeze({
  concurrency: KNOWLEDGE_WORKER_SETTINGS.spaceConcurrency,
  lockDuration: 120_000,
  stalledInterval: 30_000,
  maxStalledCount: 2,
});

export const KNOWLEDGE_IMAGE_WORKER_OPTIONS = Object.freeze({
  concurrency: KNOWLEDGE_WORKER_SETTINGS.imageConcurrency,
  lockDuration: 120_000,
  stalledInterval: 30_000,
  maxStalledCount: 2,
});

export function knowledgeImageJobOptions(jobId: string) {
  return {
    jobId,
    attempts: 3,
    backoff: {
      type: 'exponential' as const,
      delay: KNOWLEDGE_COMPILE_RETRY_BACKOFF_MS,
    },
  };
}

function integerSetting(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
