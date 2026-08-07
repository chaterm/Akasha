import { Injectable } from '@nestjs/common';
import {
  KnowledgeSpaceExecutionRepo,
  SpaceExecutionLease,
} from '@akasha/db/repos/llm-wiki/knowledge-space-execution.repo';
import { KnowledgeLinkResolverService } from './knowledge-link-resolver.service';

export type KnowledgeSpaceFinalizationResult =
  | {
      outcome: 'completed';
      resolvedCanonicalLinkCount: number;
    }
  | {
      outcome: 'superseded';
      resolvedCanonicalLinkCount: 0;
    };

/**
 * Performs the single, bounded Space-level convergence step after all page and
 * image work reaches a terminal state. The Run state machine owns the barrier
 * and terminal outcome; this service deliberately performs no LLM, embedding,
 * Catalog, or artifact synthesis work.
 */
@Injectable()
export class KnowledgeSpaceFinalizerService {
  constructor(
    private readonly executionRepo: KnowledgeSpaceExecutionRepo,
    private readonly linkResolver: KnowledgeLinkResolverService,
  ) {}

  async finalizeLeased(
    lease: SpaceExecutionLease,
    input: {
      workspaceId: string;
      spaceId: string;
      abortSignal?: AbortSignal;
    },
  ): Promise<KnowledgeSpaceFinalizationResult> {
    if (!(await this.executionRepo.isLeaseActive(lease))) {
      return supersededResult();
    }

    const { resolvedLinkCount } = await this.linkResolver.resolveSpace(input);

    // Link resolution is idempotent. If the lease was superseded while the
    // scoped UPDATE ran, the new owner may safely repeat finalization, while
    // this worker must not complete the Run.
    if (!(await this.executionRepo.isLeaseActive(lease))) {
      return supersededResult();
    }

    return {
      outcome: 'completed',
      resolvedCanonicalLinkCount: resolvedLinkCount,
    };
  }
}

function supersededResult(): KnowledgeSpaceFinalizationResult {
  return { outcome: 'superseded', resolvedCanonicalLinkCount: 0 };
}
