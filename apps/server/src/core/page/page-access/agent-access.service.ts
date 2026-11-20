import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Page, User } from '@akasha/db/types/entity.types';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import type { AgentAccessContext } from '../../../common/auth/agent-access-context';

@Injectable()
export class AgentAccessService {
  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  async getBoundSpaceIds(context: AgentAccessContext): Promise<string[]> {
    return (
      context.spaceIds ??
      this.apiKeyRepo.findSpaceIdsByApiKeyId(context.apiKeyId)
    );
  }

  async assertSpaceBound(
    context: AgentAccessContext,
    spaceId: string,
  ): Promise<void> {
    const boundSpaceIds = await this.getBoundSpaceIds(context);
    if (!boundSpaceIds.includes(spaceId)) {
      throw new ForbiddenException('Space is outside the Agent API key scope');
    }
  }

  async assertPageReadable(
    context: AgentAccessContext,
    page: Page,
    user: User,
  ): Promise<{ canEdit: boolean; hasRestriction: boolean }> {
    if (page.workspaceId !== context.workspace.id || page.deletedAt) {
      throw new ForbiddenException();
    }
    await this.assertSpaceBound(context, page.spaceId);

    const { hasAnyRestriction, canAccess } =
      await this.pagePermissionRepo.canUserEditPage(user.id, page.id);
    if (hasAnyRestriction && !canAccess) {
      throw new ForbiddenException();
    }

    return { canEdit: false, hasRestriction: hasAnyRestriction };
  }
}
