import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type JobLogContext = {
  requestId: string;
  jobId: string;
  jobName: string;
  attempt?: number;
};

const storage = new AsyncLocalStorage<JobLogContext>();

export function getJobContext(): JobLogContext | undefined {
  return storage.getStore();
}

export function runWithJobContext<T>(
  context: Omit<JobLogContext, 'requestId'> & { requestId?: string },
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(
    { ...context, requestId: context.requestId || randomUUID() },
    fn,
  );
}
