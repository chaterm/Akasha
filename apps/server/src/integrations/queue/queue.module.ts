import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EnvironmentService } from '../environment/environment.service';
import { createRetryStrategy, parseRedisUrl } from '../../common/helpers';
import { QueueName } from './constants';
import { GeneralQueueProcessor } from './processors/general-queue.processor';

export const SPACE_QUEUE_DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 31_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 1_000 },
};

export const IMAGE_QUEUE_DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 3_600, count: 100_000 },
  removeOnFail: { age: 86_400, count: 10_000 },
  attempts: 1,
};

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (environmentService: EnvironmentService) => {
        const redisConfig = parseRedisUrl(environmentService.getRedisUrl());
        return {
          connection: {
            ...redisConfig,
            retryStrategy: createRetryStrategy(),
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 20 * 1000,
            },
            removeOnComplete: {
              count: 200,
            },
            removeOnFail: {
              count: 100,
            },
          },
        };
      },
      inject: [EnvironmentService],
    }),
    BullModule.registerQueue({
      name: QueueName.EMAIL_QUEUE,
    }),
    BullModule.registerQueue({
      name: QueueName.ATTACHMENT_QUEUE,
    }),
    BullModule.registerQueue({
      name: QueueName.GENERAL_QUEUE,
    }),
    BullModule.registerQueue({
      name: QueueName.BILLING_QUEUE,
    }),
    BullModule.registerQueue({
      name: QueueName.FILE_TASK_QUEUE,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 1,
      },
    }),
    BullModule.registerQueue({
      name: QueueName.SEARCH_QUEUE,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 2,
      },
    }),
    BullModule.registerQueue({
      name: QueueName.KNOWLEDGE_SPACE_QUEUE,
      defaultJobOptions: SPACE_QUEUE_DEFAULT_JOB_OPTIONS,
    }),
    BullModule.registerQueue({
      name: QueueName.KNOWLEDGE_TEXT_QUEUE,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 1,
      },
    }),
    BullModule.registerQueue({
      name: QueueName.KNOWLEDGE_IMAGE_QUEUE,
      defaultJobOptions: IMAGE_QUEUE_DEFAULT_JOB_OPTIONS,
    }),
    BullModule.registerQueue({
      name: QueueName.HISTORY_QUEUE,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 2,
      },
    }),
    BullModule.registerQueue({
      name: QueueName.NOTIFICATION_QUEUE,
    }),
    BullModule.registerQueue({
      name: QueueName.AUDIT_QUEUE,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
      },
    }),
  ],
  exports: [BullModule],
  providers: [GeneralQueueProcessor],
})
export class QueueModule {}
