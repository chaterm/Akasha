jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));

import { getQueueToken } from '@nestjs/bullmq';
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { PageService } from '../../core/page/services/page.service';
import { WorkspaceService } from '../../core/workspace/services/workspace.service';
import { SpaceListener } from '../../database/listeners/space.listener';
import { WorkspaceListener } from '../../database/listeners/workspace.listener';
import { KnowledgeSpaceCompilationService } from '../../ee/llm-wiki/services/knowledge-space-compilation.service';
import { KnowledgeSpaceResetService } from '../../ee/llm-wiki/services/knowledge-space-reset.service';
import { QueueName } from './constants';

describe('queue injection boundaries', () => {
  it.each([
    [PageService, [QueueName.ATTACHMENT_QUEUE, QueueName.GENERAL_QUEUE]],
    [WorkspaceService, [QueueName.ATTACHMENT_QUEUE, QueueName.BILLING_QUEUE]],
    [SpaceListener, [QueueName.SEARCH_QUEUE]],
    [WorkspaceListener, [QueueName.SEARCH_QUEUE]],
    [
      KnowledgeSpaceCompilationService,
      [
        QueueName.KNOWLEDGE_IMAGE_QUEUE,
        QueueName.KNOWLEDGE_SPACE_QUEUE,
      ],
    ],
    [
      KnowledgeSpaceResetService,
      [QueueName.KNOWLEDGE_SPACE_QUEUE, QueueName.KNOWLEDGE_IMAGE_QUEUE],
    ],
  ])('%p injects only its supported queues', (target, expectedQueues) => {
    const dependencies =
      Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) ?? [];
    const actualQueueTokens = dependencies
      .map((dependency: { param: unknown }) => dependency.param)
      .filter(
        (token: unknown): token is string =>
          typeof token === 'string' && token.startsWith('BullQueue_'),
      )
      .sort();

    expect(actualQueueTokens).toEqual(
      expectedQueues.map((queue) => getQueueToken(queue)).sort(),
    );
  });
});
