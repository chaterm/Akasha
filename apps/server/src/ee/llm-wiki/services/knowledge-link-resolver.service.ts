import { Injectable } from '@nestjs/common';
import { KnowledgeCapsuleRepo } from '@akasha/db/repos/llm-wiki/knowledge-capsule.repo';

@Injectable()
export class KnowledgeLinkResolverService {
  constructor(private readonly capsuleRepo: KnowledgeCapsuleRepo) {}

  async resolveSpace(input: { workspaceId: string; spaceId: string }) {
    return this.capsuleRepo.resolveCanonicalLinks(input);
  }
}
