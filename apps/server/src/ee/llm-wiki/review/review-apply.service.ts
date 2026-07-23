import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KnowledgeReviewApplicationRepo } from '@akasha/db/repos/llm-wiki/knowledge-review-application.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { JsonObject, JsonValue } from '@akasha/db/types/db';
import {
  KnowledgeReviewApplication as KnowledgeReviewApplicationRow,
  Page,
  User,
} from '@akasha/db/types/entity.types';
import { jsonToMarkdown } from '../../../collaboration/collaboration.util';
import SpaceAbilityFactory from '../../../core/casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../../../core/casl/interfaces/space-ability.type';
import { PageAccessService } from '../../../core/page/page-access/page-access.service';
import { UpdatePageDto } from '../../../core/page/dto/update-page.dto';
import { PageService } from '../../../core/page/services/page.service';
import { SearchResult } from './search-provider';
import { ReviewDocMeta } from './knowledge-artifact-wiki-source';
import {
  DraftApplyOperation,
  DraftApplyOperations,
  DraftContent,
  ReviewApplication,
  ReviewApplyOperation,
  ReviewItem,
  ReviewSourceRef,
  reviewApplicationDiffSchema,
  reviewApplicationSchema,
  ReviewApplicationDiff,
} from './review.schema';

type PageWithContent = Page & {
  content?: unknown;
  space?: { slug?: string | null } | null;
};

@Injectable()
export class ReviewApplyService {
  constructor(
    private readonly pageService: PageService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly applicationRepo: KnowledgeReviewApplicationRepo,
  ) {}

  async supersedeDraftApplications(input: {
    workspaceId: string;
    spaceId: string;
    reviewItemId: string;
  }): Promise<number> {
    return this.applicationRepo.supersedeDraftsForReviewItem(input);
  }

  async planDraft(input: {
    workspaceId: string;
    spaceId: string;
    user: User;
    item: ReviewItem;
    draft: DraftContent;
    docs: ReviewDocMeta[];
    searchResults?: SearchResult[];
  }): Promise<ReviewApplication> {
    const applyOperations = normalizeApplyOperations(input.draft, input.item);
    const operation = toReviewApplyOperation(applyOperations);

    if (operation === 'create_page') {
      await this.validateCanCreatePage(input.user, input.spaceId);
      const afterContent = normalizeMarkdown(input.draft.body);
      const row = await this.applicationRepo.insertApplication({
        workspaceId: input.workspaceId,
        spaceId: input.spaceId,
        reviewItemId: input.item.id,
        status: 'draft',
        operation,
        targetPageId: null,
        targetPageTitle: input.draft.title,
        targetHeadingPath: [],
        basePageVersion: null,
        baseContentHash: null,
        beforeContent: null,
        afterContent,
        afterContentHash: hashContent(afterContent),
        patch: buildPatch(input.item, input.draft, operation, {
          applyOperations,
          targetHeadingPath: [],
          strategy: strategyForDraftOperations(applyOperations),
        }),
        createdPageId: null,
        appliedAt: null,
        revertedAt: null,
        appliedBy: input.user.id,
        rationale: input.draft.notes || input.item.recommendation,
        sourceRefs: buildSourceRefs(
          input.item,
          input.docs,
          input.searchResults,
        ),
      });
      return toReviewApplication(row);
    }

    const sourcePageId = resolveTargetSourcePageId(
      input.item,
      input.draft,
      input.docs,
    );
    if (!sourcePageId) {
      throw new BadRequestException(
        'Review draft could not be mapped to a writable source page',
      );
    }

    const page = await this.loadWritablePage(sourcePageId, input.user);
    const beforeContent = markdownFromPage(page);
    const planned = buildPlannedContent(
      beforeContent,
      input.draft,
      applyOperations,
    );
    const currentPageTitle = page.title ?? 'Untitled';
    const proposedPageTitle = plannedPageTitleChange(
      applyOperations,
      input.draft,
      currentPageTitle,
    );

    const row = await this.applicationRepo.insertApplication({
      workspaceId: input.workspaceId,
      spaceId: input.spaceId,
      reviewItemId: input.item.id,
      status: 'draft',
      operation: planned.operation,
      targetPageId: page.id,
      targetPageTitle: page.title ?? 'Untitled',
      targetHeadingPath: planned.targetHeadingPath,
      basePageVersion: page.updatedAt.toISOString(),
      baseContentHash: hashContent(beforeContent),
      beforeContent,
      afterContent: planned.afterContent,
      afterContentHash: hashContent(planned.afterContent),
      patch: buildPatch(input.item, input.draft, planned.operation, {
        ...planned,
        applyOperations,
        originalPageTitle: currentPageTitle,
        proposedPageTitle,
      }),
      createdPageId: null,
      appliedAt: null,
      revertedAt: null,
      appliedBy: input.user.id,
      rationale: input.draft.notes || input.item.recommendation,
      sourceRefs: buildSourceRefs(input.item, input.docs, input.searchResults),
    });
    return toReviewApplication(row);
  }

  async applyApplication(input: {
    workspaceId: string;
    user: User;
    applicationId: string;
  }): Promise<ReviewApplication> {
    const application = await this.loadApplication(
      input.workspaceId,
      input.applicationId,
    );

    if (application.status === 'applied') {
      return application;
    }
    if (application.status !== 'draft') {
      throw new BadRequestException(
        `Cannot apply a review application in ${application.status} status`,
      );
    }

    if (application.operation === 'create_page') {
      await this.validateCanCreatePage(input.user, application.spaceId);
      const created = await this.pageService.create(
        input.user.id,
        input.workspaceId,
        {
          title: application.targetPageTitle ?? 'Untitled',
          spaceId: application.spaceId,
          content: application.afterContent,
          format: 'markdown',
        },
      );
      const page = await this.pageRepo.findById(created.id, {
        includeContent: true,
        includeSpace: true,
      });
      if (!page) {
        throw new NotFoundException('Created page not found');
      }
      const actualAfterContent =
        markdownFromPage(page as PageWithContent) || application.afterContent;
      const updated = await this.applicationRepo.updateApplication({
        workspaceId: input.workspaceId,
        id: application.id,
        patch: {
          status: 'applied',
          targetPageId: page.id,
          targetPageTitle: page.title ?? application.targetPageTitle,
          createdPageId: page.id,
          afterContent: actualAfterContent,
          afterContentHash: hashContent(actualAfterContent),
          appliedAt: new Date(),
        },
      });
      return toReviewApplication(updated);
    }

    const page = await this.loadWritablePage(
      application.targetPageId,
      input.user,
    );
    const currentContent = markdownFromPage(page);
    if (hashContent(currentContent) !== application.baseContentHash) {
      await this.markConflicted(input.workspaceId, application.id);
      throw new ConflictException(
        'Target page has changed since this review application was planned',
      );
    }

    const currentPageTitle = page.title ?? application.targetPageTitle;
    const proposedPageTitle = proposedPageTitleFor(
      application,
      currentPageTitle,
    );
    const updatedPage =
      application.operation === 'rename_page'
        ? await this.updatePageTitle(page, input.user, proposedPageTitle)
        : await this.replacePageContent(
            page,
            application.afterContent,
            input.user,
            proposedPageTitle,
          );
    const actualAfterContent = markdownFromPage(updatedPage);
    const updated = await this.applicationRepo.updateApplication({
      workspaceId: input.workspaceId,
      id: application.id,
      patch: {
        status: 'applied',
        targetPageTitle: updatedPage.title ?? application.targetPageTitle,
        afterContent: actualAfterContent,
        afterContentHash: hashContent(actualAfterContent),
        appliedAt: new Date(),
        ...(proposedPageTitle
          ? {
              patch: patchWithTitleChange(
                application.patch,
                currentPageTitle,
                proposedPageTitle,
              ),
            }
          : {}),
      },
    });
    return toReviewApplication(updated);
  }

  async revertApplication(input: {
    workspaceId: string;
    user: User;
    applicationId: string;
  }): Promise<ReviewApplication> {
    const application = await this.loadApplication(
      input.workspaceId,
      input.applicationId,
    );

    if (application.status === 'reverted') {
      return application;
    }
    const canRetryConflictedRevert =
      application.status === 'conflicted' && Boolean(application.appliedAt);
    if (application.status !== 'applied' && !canRetryConflictedRevert) {
      throw new BadRequestException(
        `Cannot revert a review application in ${application.status} status`,
      );
    }

    if (application.operation === 'create_page') {
      const page = await this.loadWritablePage(
        application.createdPageId ?? application.targetPageId,
        input.user,
      );
      const currentContent = markdownFromPage(page);
      if (hasPageChangedSinceApplication(page, application, currentContent)) {
        await this.markConflicted(input.workspaceId, application.id);
        throw new ConflictException(
          'Created page has changed since the review application was applied',
        );
      }

      await this.pageService.removePage(
        page.id,
        input.user.id,
        input.workspaceId,
      );
      const updated = await this.applicationRepo.updateApplication({
        workspaceId: input.workspaceId,
        id: application.id,
        patch: {
          status: 'reverted',
          revertedAt: new Date(),
        },
      });
      return toReviewApplication(updated);
    }

    if (application.beforeContent === null) {
      throw new BadRequestException(
        'Review application does not have content to restore',
      );
    }

    const page = await this.loadWritablePage(
      application.targetPageId,
      input.user,
    );
    const currentContent = markdownFromPage(page);
    if (hasPageChangedSinceApplication(page, application, currentContent)) {
      await this.markConflicted(input.workspaceId, application.id);
      throw new ConflictException(
        'Target page has changed since the review application was applied',
      );
    }

    const originalTitle = originalPageTitleFor(application);
    if (application.operation === 'rename_page') {
      await this.updatePageTitle(page, input.user, originalTitle);
    } else {
      await this.replacePageContent(
        page,
        application.beforeContent,
        input.user,
        originalTitle,
      );
    }
    const updated = await this.applicationRepo.updateApplication({
      workspaceId: input.workspaceId,
      id: application.id,
      patch: {
        status: 'reverted',
        targetPageTitle: originalTitle ?? application.targetPageTitle,
        revertedAt: new Date(),
      },
    });
    return toReviewApplication(updated);
  }

  async getDiff(input: {
    workspaceId: string;
    applicationId: string;
  }): Promise<ReviewApplicationDiff> {
    const application = await this.loadApplication(
      input.workspaceId,
      input.applicationId,
    );
    return reviewApplicationDiffSchema.parse({
      application,
      beforeContent: application.beforeContent,
      afterContent: application.afterContent,
    });
  }

  private async loadApplication(
    workspaceId: string,
    applicationId: string,
  ): Promise<ReviewApplication> {
    const row = await this.applicationRepo.findById({
      workspaceId,
      id: applicationId,
    });
    if (!row) {
      throw new NotFoundException('Review application not found');
    }
    return toReviewApplication(row);
  }

  private async markConflicted(workspaceId: string, applicationId: string) {
    await this.applicationRepo.updateApplication({
      workspaceId,
      id: applicationId,
      patch: { status: 'conflicted' },
    });
  }

  private async validateCanCreatePage(user: User, spaceId: string) {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  private async loadWritablePage(
    pageId: string | null,
    user: User,
  ): Promise<PageWithContent> {
    if (!pageId) {
      throw new BadRequestException('Review application has no target page');
    }

    const page = (await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeSpace: true,
    })) as PageWithContent | null;
    if (!page || page.deletedAt) {
      throw new NotFoundException('Target page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);
    return page;
  }

  private async replacePageContent(
    page: Page,
    content: string,
    user: User,
    title?: string | null,
  ): Promise<PageWithContent> {
    const updateDto: UpdatePageDto = {
      pageId: page.id,
      content: content || '\n',
      format: 'markdown',
      operation: 'replace',
    };
    if (title) {
      updateDto.title = title;
    }
    return (await this.pageService.update(
      page,
      updateDto,
      user,
    )) as PageWithContent;
  }

  private async updatePageTitle(
    page: Page,
    user: User,
    title?: string | null,
  ): Promise<PageWithContent> {
    if (!title) {
      throw new BadRequestException('Review application has no page title');
    }

    const updateDto: UpdatePageDto = {
      pageId: page.id,
      title,
    };
    return (await this.pageService.update(
      page,
      updateDto,
      user,
    )) as PageWithContent;
  }
}

/**
 * 按 review type 校验并纠正 AI 给出的 applyOperation(代码兜底,不信任 AI 自律)。
 * 原则:能由 type 唯一确定写动作的,直接代码定;只有 suggestion 真正需要 AI 的语义判断
 * (append 补充 / replace 重写 / rename 改名),此时才信任 AI 的选择,但仍纠正非法组合。
 *
 * - missing-page  → 必为 create-page(缺页只能新建)。
 * - contradiction → 有目标页则 replace-page(改写保留页);无目标页则 create-page(辨析新页)。
 * - duplicate     → 必为 replace-page(合并写回主页)。
 * - suggestion    → 信任 AI 在 append/replace/rename 三者间的选择;但若 AI 给了 create-page
 *                   这种"对现有页却新建"的非法组合,纠正为 append-section(最小侵入的补充)。
 */
function normalizeApplyOperations(
  draft: DraftContent,
  item: ReviewItem,
): DraftApplyOperations {
  const requested = normalizeRequestedApplyOperations(draft.applyOperation);
  const hasTarget = Boolean(draft.targetDocId ?? fallbackTargetDocId(item));

  switch (item.type) {
    case 'missing-page':
      return ['create-page'];
    case 'contradiction':
      return hasTarget
        ? normalizeExistingPageOperations(requested, 'replace-page', {
            forceContentOperation: true,
          })
        : ['create-page'];
    case 'duplicate':
      return normalizeExistingPageOperations(requested, 'replace-page', {
        forceContentOperation: true,
      });
    case 'suggestion':
      // suggestion 无明确目标时按新页兜底;有目标时允许 append/replace/rename 的组合。
      return hasTarget
        ? normalizeExistingPageOperations(requested, 'append-section')
        : ['create-page'];
  }
}

function toReviewApplyOperation(
  operations: DraftApplyOperations,
): ReviewApplyOperation {
  if (operations.includes('create-page')) return 'create_page';
  if (operations.includes('replace-page')) return 'replace_page';
  if (operations.includes('append-section')) return 'append_section';
  return 'rename_page';
}

function normalizeRequestedApplyOperations(
  value: DraftApplyOperation | DraftApplyOperation[],
): DraftApplyOperation[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter(isDraftApplyOperation))];
}

function normalizeExistingPageOperations(
  requested: DraftApplyOperation[],
  fallbackContentOperation: Extract<
    DraftApplyOperation,
    'append-section' | 'replace-page'
  >,
  options: { forceContentOperation?: boolean } = {},
): DraftApplyOperations {
  const wantsRename = requested.includes('rename-page');
  const requestedContentOperation = requested.includes('replace-page')
    ? 'replace-page'
    : requested.includes('append-section')
      ? 'append-section'
      : null;
  const contentOperation = options.forceContentOperation
    ? fallbackContentOperation
    : (requestedContentOperation ??
      (!wantsRename ? fallbackContentOperation : null));
  const operations: DraftApplyOperation[] = [];

  if (wantsRename) {
    operations.push('rename-page');
  }
  if (contentOperation) {
    operations.push(contentOperation);
  }

  return operations.length > 0
    ? (operations.slice(0, 2) as DraftApplyOperations)
    : [fallbackContentOperation];
}

function isDraftApplyOperation(value: unknown): value is DraftApplyOperation {
  return (
    value === 'create-page' ||
    value === 'append-section' ||
    value === 'replace-page' ||
    value === 'rename-page'
  );
}

function resolveTargetSourcePageId(
  item: ReviewItem,
  draft: DraftContent,
  docs: ReviewDocMeta[],
): string | undefined {
  const docsById = new Map(docs.map((doc) => [doc.id, doc]));
  const explicitTargetId = draft.targetDocId ?? fallbackTargetDocId(item);
  return explicitTargetId
    ? docsById.get(explicitTargetId)?.sourcePageId
    : undefined;
}

function fallbackTargetDocId(item: ReviewItem): string | null {
  switch (item.type) {
    case 'suggestion':
      return item.targetDocId;
    case 'duplicate':
      return item.suggestedPrimaryId;
    default:
      return null;
  }
}

function markdownFromPage(page: PageWithContent): string {
  return page.content ? normalizeMarkdown(jsonToMarkdown(page.content)) : '';
}

function buildPlannedContent(
  beforeContent: string,
  draft: DraftContent,
  applyOperations: DraftApplyOperations,
): {
  operation: ReviewApplyOperation;
  targetHeadingPath: string[];
  afterContent: string;
  strategy: string;
} {
  if (applyOperations.includes('append-section')) {
    return {
      operation: 'append_section',
      targetHeadingPath: [],
      afterContent: appendSection(beforeContent, ensureSectionMarkdown(draft)),
      strategy: strategyForDraftOperations(applyOperations),
    };
  }

  if (applyOperations.includes('replace-page')) {
    return {
      operation: 'replace_page',
      targetHeadingPath: [],
      afterContent: normalizeMarkdown(draft.body),
      strategy: strategyForDraftOperations(applyOperations),
    };
  }

  if (applyOperations.includes('rename-page')) {
    return {
      operation: 'rename_page',
      targetHeadingPath: [],
      afterContent: beforeContent,
      strategy: strategyForDraftOperations(applyOperations),
    };
  }

  return {
    operation: 'create_page',
    targetHeadingPath: [],
    afterContent: normalizeMarkdown(draft.body),
    strategy: strategyForDraftOperations(applyOperations),
  };
}

function strategyForDraftOperations(operations: DraftApplyOperations): string {
  return operations.map((operation) => operation.replace(/-/g, '_')).join('+');
}

function insertSection(
  beforeContent: string,
  draft: DraftContent,
): {
  operation: ReviewApplyOperation;
  targetHeadingPath: string[];
  afterContent: string;
  strategy: string;
} {
  const target = findHeading(beforeContent, candidateHeadingTitles(draft));
  if (!target) {
    const section = ensureSectionMarkdown(draft);
    return {
      operation: 'insert_under_heading',
      targetHeadingPath: [],
      afterContent: appendSection(beforeContent, section),
      strategy: 'insert_under_page_root',
    };
  }

  const section =
    contentForMatchedHeading(draft, target.title) ||
    ensureSectionMarkdown(draft);
  const afterContent = [
    beforeContent.slice(0, target.end).trimEnd(),
    '',
    section,
    '',
    beforeContent.slice(target.end).trimStart(),
  ]
    .filter((part) => part.length > 0)
    .join('\n');

  return {
    operation: 'insert_under_heading',
    targetHeadingPath: [target.title],
    afterContent: normalizeMarkdown(afterContent),
    strategy: 'insert_under_matched_heading',
  };
}

function replaceSection(
  beforeContent: string,
  draft: DraftContent,
): {
  operation: ReviewApplyOperation;
  targetHeadingPath: string[];
  afterContent: string;
  strategy: string;
} {
  const replacement = ensureSectionMarkdown(draft);
  const target = findHeading(beforeContent, candidateHeadingTitles(draft));
  if (!target) {
    return {
      operation: 'replace_section',
      targetHeadingPath: [],
      afterContent: normalizeMarkdown(draft.body),
      strategy: 'replace_page_content_when_no_heading_matched',
    };
  }

  const afterContent = [
    beforeContent.slice(0, target.start).trimEnd(),
    replacement,
    beforeContent.slice(target.end).trimStart(),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');

  return {
    operation: 'replace_section',
    targetHeadingPath: [target.title],
    afterContent: normalizeMarkdown(afterContent),
    strategy: 'replace_matched_heading_section',
  };
}

function appendSection(beforeContent: string, section: string): string {
  return normalizeMarkdown(
    [beforeContent.trimEnd(), section].filter(Boolean).join('\n\n'),
  );
}

function ensureSectionMarkdown(draft: DraftContent): string {
  const body = normalizeMarkdown(draft.body);
  if (firstHeadingTitle(body)) {
    return body;
  }
  return normalizeMarkdown(`## ${draft.title}\n\n${body}`);
}

function contentForMatchedHeading(
  draft: DraftContent,
  targetTitle: string,
): string {
  const body = normalizeMarkdown(draft.body);
  const firstTitle = firstHeadingTitle(body);
  if (!firstTitle) {
    return body;
  }

  if (
    normalizeHeadingTitle(firstTitle) !== normalizeHeadingTitle(targetTitle)
  ) {
    return body;
  }

  return normalizeMarkdown(body.replace(/^#{1,6}\s+.+?\s*#*\s*\n?/, ''));
}

function candidateHeadingTitles(draft: DraftContent): string[] {
  return [firstHeadingTitle(draft.body), draft.title]
    .filter((title): title is string => Boolean(title))
    .map(normalizeHeadingTitle);
}

function firstHeadingTitle(markdown: string): string | null {
  const match = markdown.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m);
  return match?.[1]?.trim() || null;
}

function findHeading(
  markdown: string,
  candidates: string[],
): { title: string; start: number; end: number } | null {
  if (candidates.length === 0) return null;

  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const title = normalizeHeadingTitle(heading[2] ?? '');
    if (!candidates.includes(title)) continue;

    const level = heading[1].length;
    const start = heading.index ?? 0;
    let end = markdown.length;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next][1].length <= level) {
        end = headings[next].index ?? markdown.length;
        break;
      }
    }
    return { title: heading[2].trim(), start, end };
  }

  return null;
}

function normalizeHeadingTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').trim();
}

function buildPatch(
  item: ReviewItem,
  draft: DraftContent,
  operation: ReviewApplyOperation,
  planned?: {
    applyOperations?: DraftApplyOperations;
    targetHeadingPath: string[];
    strategy: string;
    originalPageTitle?: string;
    proposedPageTitle?: string | null;
  },
): JsonObject {
  const applyOperations = planned?.applyOperations ?? draft.applyOperation;
  return {
    reviewItemType: item.type,
    applyOperation: applyOperations,
    applyOperations,
    draftTitle: draft.title,
    targetDocId: draft.targetDocId,
    targetHeadingPath: planned?.targetHeadingPath ?? [],
    strategy: planned?.strategy ?? operation,
    originalPageTitle: planned?.originalPageTitle,
    proposedPageTitle: planned?.proposedPageTitle,
  };
}

function plannedPageTitleChange(
  applyOperations: DraftApplyOperations,
  draft: DraftContent,
  currentPageTitle: string,
): string | null {
  if (!applyOperations.includes('rename-page')) {
    return null;
  }
  return nonEmptyTitleChange(draft.title, currentPageTitle);
}

function hasPageChangedSinceApplication(
  page: PageWithContent,
  application: ReviewApplication,
  currentContent: string,
): boolean {
  const changedAfterApply =
    Boolean(application.appliedAt) &&
    page.updatedAt.getTime() > new Date(application.appliedAt).getTime();
  const titleMatches =
    !application.targetPageTitle ||
    (page.title ?? 'Untitled') === application.targetPageTitle;

  if (
    contentMatchesAppliedState(currentContent, application) &&
    (titleMatches || !changedAfterApply)
  ) {
    return false;
  }

  if (!application.appliedAt) {
    return true;
  }

  return changedAfterApply;
}

function contentMatchesAppliedState(
  currentContent: string,
  application: ReviewApplication,
): boolean {
  if (hashContent(currentContent) === application.afterContentHash) {
    return true;
  }
  return (
    normalizeForComparison(currentContent) ===
    normalizeForComparison(application.afterContent)
  );
}

function normalizeForComparison(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function proposedPageTitleFor(
  application: ReviewApplication,
  currentPageTitle?: string | null,
): string | null {
  const patch = application.patch;
  if (!isRecord(patch)) return null;
  if (typeof patch.proposedPageTitle === 'string') {
    return nonEmptyTitleChange(patch.proposedPageTitle, currentPageTitle);
  }

  const applyOperations = patchApplyOperations(patch);
  if (applyOperations) {
    return applyOperations.includes('rename-page') &&
      typeof patch.draftTitle === 'string'
      ? nonEmptyTitleChange(patch.draftTitle, currentPageTitle)
      : null;
  }

  if (!isWholePageReplacement(application, patch)) {
    return null;
  }

  return typeof patch.draftTitle === 'string'
    ? nonEmptyTitleChange(patch.draftTitle, currentPageTitle)
    : null;
}

function originalPageTitleFor(application: ReviewApplication): string | null {
  const patch = application.patch;
  if (isRecord(patch) && typeof patch.originalPageTitle === 'string') {
    return patch.originalPageTitle;
  }
  return application.targetPageTitle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function patchApplyOperations(
  patch: Record<string, unknown>,
): DraftApplyOperation[] | null {
  const raw = patch.applyOperations ?? patch.applyOperation;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const operations = [...new Set(values.filter(isDraftApplyOperation))];
  return operations.length > 0 ? operations : null;
}

function isWholePageReplacement(
  application: ReviewApplication,
  patch: Record<string, unknown>,
): boolean {
  if (
    application.operation !== 'replace_section' &&
    application.operation !== 'replace_page'
  ) {
    return false;
  }
  const targetHeadingPath = patch.targetHeadingPath;
  if (Array.isArray(targetHeadingPath) && targetHeadingPath.length > 0) {
    return false;
  }

  return (
    typeof patch.strategy !== 'string' ||
    patch.strategy === 'replace_page_content_when_no_heading_matched'
  );
}

function nonEmptyTitleChange(
  title: string,
  currentPageTitle?: string | null,
): string | null {
  const trimmed = title.trim();
  if (!trimmed) {
    return null;
  }
  if (
    currentPageTitle &&
    normalizeHeadingTitle(trimmed) === normalizeHeadingTitle(currentPageTitle)
  ) {
    return null;
  }
  return trimmed;
}

function patchWithTitleChange(
  patch: unknown,
  originalPageTitle: string | null | undefined,
  proposedPageTitle: string,
): JsonObject {
  const next: JsonObject = {};
  if (isRecord(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      if (isJsonValue(value)) {
        next[key] = value;
      }
    }
  }
  if (originalPageTitle && typeof next.originalPageTitle !== 'string') {
    next.originalPageTitle = originalPageTitle;
  }
  next.proposedPageTitle = proposedPageTitle;
  return next;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  const valueType = typeof value;
  if (
    valueType === 'string' ||
    valueType === 'number' ||
    valueType === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function buildSourceRefs(
  item: ReviewItem,
  docs: ReviewDocMeta[],
  searchResults: SearchResult[] = [],
): ReviewSourceRef[] {
  const docsById = new Map(docs.map((doc) => [doc.id, doc]));
  const wikiDocIds = new Set(
    [
      ...item.relatedDocIds,
      item.type === 'suggestion' ? item.targetDocId : null,
      item.type === 'duplicate' ? item.suggestedPrimaryId : null,
    ].filter((id): id is string => Boolean(id)),
  );

  const wikiRefs = [...wikiDocIds].map((docId): ReviewSourceRef => {
    const doc = docsById.get(docId);
    return {
      type: 'wiki',
      title: doc?.title ?? docId,
      pageId: doc?.sourcePageId ?? docId,
    };
  });

  const webRefs = searchResults.map(
    (result): ReviewSourceRef => ({
      type: 'web',
      title: result.title,
      url: result.url,
      quote: result.snippet,
    }),
  );

  return [...wikiRefs, ...webRefs];
}

function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function toReviewApplication(
  row: KnowledgeReviewApplicationRow,
): ReviewApplication {
  return reviewApplicationSchema.parse({
    ...row,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    revertedAt: row.revertedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
