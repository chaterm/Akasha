import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Page, User } from '@akasha/db/types/entity.types';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import type { AgentAccessContext } from '../../../common/auth/agent-access-context';
import { PageAccessService } from './page-access.service';

@Injectable()
export class AgentAccessService {
  constructor(
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly pageAccessService: PageAccessService,
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

    return this.pageAccessService.validateCanViewWithPermissions(page, user);
  }

  async assertPageWritable(
    context: AgentAccessContext,
    page: Page,
    user: User,
  ): Promise<{ hasRestriction: boolean }> {
    if (page.workspaceId !== context.workspace.id || page.deletedAt) {
      throw new ForbiddenException();
    }
    await this.assertSpaceBound(context, page.spaceId);

    return this.pageAccessService.validateCanEdit(page, user);
  }

  async assertCanCreate(
    context: AgentAccessContext,
    spaceId: string,
    user: User,
    parentPage?: Page,
  ): Promise<void> {
    await this.assertSpaceBound(context, spaceId);
    if (!parentPage) return;
    if (
      parentPage.workspaceId !== context.workspace.id ||
      parentPage.spaceId !== spaceId ||
      parentPage.deletedAt
    ) {
      throw new ForbiddenException();
    }
    await this.assertPageWritable(context, parentPage, user);
  }
}
