import { WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { runWithJobContext } from './job-context';

export abstract class ContextualWorkerHost extends WorkerHost {
  abstract handle(job: Job, token?: string): Promise<any>;

  process(job: Job, token?: string): Promise<any> {
    return runWithJobContext(
      {
        jobId: String(job.id ?? ''),
        jobName: job.name,
        attempt: job.attemptsMade + 1,
      },
      () => this.handle(job, token),
    );
  }
}
