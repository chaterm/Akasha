import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PageService } from './services/page.service';
import { BacklinkService } from './services/backlink.service';
import { PageAccessService } from './page-access/page-access.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { MovePageDto, MovePageToSpaceDto } from './dto/move-page.dto';
import {
  DeletePageDto,
  AddPagePermissionDto,
  PageHistoryIdDto,
  PageIdDto,
  PageInfoDto,
  PersonalPageSearchDto,
  RemovePagePermissionDto,
  UpdatePagePermissionRoleDto,
} from './dto/page.dto';
import { PageHistoryService } from './services/page-history.service';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { Page, User, Workspace } from '@akasha/db/types/entity.types';
import { SidebarPageDto } from './dto/sidebar-page.dto';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { RecentPageDto } from './dto/recent-page.dto';
import { CreatedByUserDto } from './dto/created-by-user.dto';
import { DuplicatePageDto } from './dto/duplicate-page.dto';
import { DeletedPageDto } from './dto/deleted-page.dto';
import { BacklinksListDto } from './dto/backlink.dto';
import { LabelService } from '../label/label.service';
import { AddLabelsDto, RemoveLabelDto } from '../label/dto/label.dto';
import {
  jsonToHtml,
  jsonToMarkdown,
} from '../../collaboration/collaboration.util';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { getPageTitle } from '../../common/helpers';
import {
  PageAccessLevel,
  PagePermissionRole,
  UserRole,
} from '../../common/helpers/types/permission';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
import { resolvePageAuthorDisplay } from './services/page-author-display';
import { RestorePageAuthorsDto } from './dto/restore-page-authors.dto';
import { PageAuthorMigrationService } from './services/page-author-migration.service';
import { getApiKeyAccess } from '../../common/auth/api-key-access';

function pageSearchExcerpt(text: string | null, query: string): string {
  if (!text) return '';
  const maxLength = 240;
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const center = index >= 0 ? index : 0;
  const start = Math.max(0, center - 80);
  const excerpt = text.slice(start, start + maxLength);
  return `${start > 0 ? '…' : ''}${excerpt}${
    start + maxLength < text.length ? '…' : ''
  }`;
}

@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageController {
  constructor(
    private readonly pageService: PageService,
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageHistoryService: PageHistoryService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageAccessService: PageAccessService,
    private readonly backlinkService: BacklinkService,
    private readonly labelService: LabelService,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    private readonly pageAuthorMigrationService: PageAuthorMigrationService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('/info')
  async getPage(@Body() dto: PageInfoDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId, {
      includeSpace: true,
      includeContent: true,
      includeCreator: true,
      includeLastUpdatedBy: true,
      includeContributors: true,
      includeDeletedBy: true,
    });

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const { canEdit, hasRestriction } =
      await this.pageAccessService.validateCanReadSourceWithPermissions(
        page,
        user,
      );

    const permissions = { canEdit, hasRestriction };
    const displayPage = resolvePageAuthorDisplay(page);

    if (dto.format && dto.format !== 'json' && page.content) {
      const contentOutput =
        dto.format === 'markdown'
          ? jsonToMarkdown(page.content)
          : jsonToHtml(page.content);
      return {
        ...displayPage,
        content: contentOutput,
        permissions,
      };
    }

    return { ...displayPage, permissions };
  }

  @HttpCode(HttpStatus.OK)
  @Post('/search')
  async searchPersonalPages(
    @Body() dto: PersonalPageSearchDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const personalSpaceId = getApiKeyAccess(user)?.personalSpaceId;
    if (!personalSpaceId) {
      throw new ForbiddenException(
        'API key personal space is required for Page source search',
      );
    }

    const pages = await this.pageRepo.searchPagesInSpace({
      workspaceId: workspace.id,
      spaceId: personalSpaceId,
      query: dto.query,
      limit: dto.limit,
    });

    return {
      items: pages.map((page) => ({
        pageId: page.id,
        title: getPageTitle(page.title),
        excerpt: pageSearchExcerpt(page.textContent, dto.query),
        updatedAt: page.updatedAt,
      })),
      meta: {
        count: pages.length,
        limit: dto.limit,
      },
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('migration/restore-authors')
  async restoreAuthors(
    @Body() dto: RestorePageAuthorsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const pageIds = [...new Set(dto.items.map((item) => item.pageId))];
    const spaceIds = await this.pageRepo.findSpaceIdsForPages({
      workspaceId: workspace.id,
      pageIds,
    });

    for (const spaceId of spaceIds) {
      try {
        const ability = await this.spaceAbility.createForUser(user, spaceId);
        if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
          throw new ForbiddenException();
        }
      } catch {
        throw new ForbiddenException();
      }
    }

    return this.pageAuthorMigrationService.restorePageAuthors(
      dto.items,
      workspace.id,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('labels')
  async getPageLabels(
    @Body() dto: PageIdDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return this.labelService.getPageLabels(page.id, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('permission-info')
  async getPagePermissionInfo(@Body() dto: PageIdDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const permissions =
      await this.pageAccessService.validateCanViewWithPermissions(page, user);
    const pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    const restrictedAncestor =
      await this.pagePermissionRepo.findRestrictedAncestor(page.id);

    let inheritedFrom:
      | { id: string; slugId: string; title: string }
      | undefined;
    if (restrictedAncestor && restrictedAncestor.depth > 0) {
      const ancestor = await this.pageRepo.findById(restrictedAncestor.pageId);
      if (ancestor) {
        inheritedFrom = {
          id: ancestor.id,
          slugId: ancestor.slugId,
          title: getPageTitle(ancestor.title),
        };
      }
    }

    return {
      restrictionId: pageAccess?.id,
      hasDirectRestriction: Boolean(pageAccess),
      hasInheritedRestriction: Boolean(
        restrictedAncestor && restrictedAncestor.depth > 0,
      ),
      inheritedFrom,
      userAccess: {
        canView: true,
        canEdit: permissions.canEdit,
        canManage: permissions.canEdit,
      },
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('permissions')
  async getPagePermissions(
    @Body() dto: PageIdDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    const pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (!pageAccess) {
      return {
        items: [],
        meta: {
          limit: pagination.limit,
          hasNextPage: false,
          hasPrevPage: false,
          nextCursor: null,
          prevCursor: null,
        },
      };
    }

    return this.pagePermissionRepo.getPagePermissionsPaginated(
      pageAccess.id,
      pagination,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('restrict')
  async restrictPage(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt || page.workspaceId !== workspace.id) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);

    await executeTx(this.db, async (trx) => {
      let pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
        page.id,
        trx,
      );
      if (!pageAccess) {
        pageAccess = await this.pagePermissionRepo.insertPageAccess(
          {
            pageId: page.id,
            workspaceId: workspace.id,
            spaceId: page.spaceId,
            accessLevel: PageAccessLevel.RESTRICTED,
            creatorId: user.id,
          },
          trx,
        );
      }

      const existing = await this.pagePermissionRepo.findPagePermissionByUserId(
        pageAccess.id,
        user.id,
        trx,
      );
      if (existing) {
        await this.pagePermissionRepo.updatePagePermissionRole(
          pageAccess.id,
          PagePermissionRole.WRITER,
          { userId: user.id },
          trx,
        );
      } else {
        await this.pagePermissionRepo.insertPagePermissions(
          [
            {
              pageAccessId: pageAccess.id,
              userId: user.id,
              role: PagePermissionRole.WRITER,
              addedById: user.id,
            },
          ],
          trx,
        );
      }
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-restriction')
  async removePageRestriction(@Body() dto: PageIdDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);
    await this.pagePermissionRepo.deletePageAccess(page.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('add-permission')
  async addPagePermission(
    @Body() dto: AddPagePermissionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const userIds = dto.userIds ?? [];
    const groupIds = dto.groupIds ?? [];
    if (userIds.length === 0 && groupIds.length === 0) {
      throw new BadRequestException('No users or groups provided');
    }

    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt || page.workspaceId !== workspace.id) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);

    await executeTx(this.db, async (trx) => {
      let pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
        page.id,
        trx,
      );
      if (!pageAccess) {
        pageAccess = await this.pagePermissionRepo.insertPageAccess(
          {
            pageId: page.id,
            workspaceId: workspace.id,
            spaceId: page.spaceId,
            accessLevel: PageAccessLevel.RESTRICTED,
            creatorId: user.id,
          },
          trx,
        );
      }

      for (const userId of userIds) {
        const existing =
          await this.pagePermissionRepo.findPagePermissionByUserId(
            pageAccess.id,
            userId,
            trx,
          );
        if (existing) {
          await this.pagePermissionRepo.updatePagePermissionRole(
            pageAccess.id,
            dto.role,
            { userId },
            trx,
          );
        } else {
          await this.pagePermissionRepo.insertPagePermissions(
            [
              {
                pageAccessId: pageAccess.id,
                userId,
                role: dto.role,
                addedById: user.id,
              },
            ],
            trx,
          );
        }
      }

      for (const groupId of groupIds) {
        const existing =
          await this.pagePermissionRepo.findPagePermissionByGroupId(
            pageAccess.id,
            groupId,
            trx,
          );
        if (existing) {
          await this.pagePermissionRepo.updatePagePermissionRole(
            pageAccess.id,
            dto.role,
            { groupId },
            trx,
          );
        } else {
          await this.pagePermissionRepo.insertPagePermissions(
            [
              {
                pageAccessId: pageAccess.id,
                groupId,
                role: dto.role,
                addedById: user.id,
              },
            ],
            trx,
          );
        }
      }
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-permission')
  async removePagePermission(
    @Body() dto: RemovePagePermissionDto,
    @AuthUser() user: User,
  ) {
    const userIds = dto.userIds ?? [];
    const groupIds = dto.groupIds ?? [];
    if (userIds.length === 0 && groupIds.length === 0) {
      throw new BadRequestException('No users or groups provided');
    }

    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);
    const pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (!pageAccess) {
      return;
    }

    await executeTx(this.db, async (trx) => {
      await this.pagePermissionRepo.deletePagePermissionsByUserIds(
        pageAccess.id,
        userIds,
        trx,
      );
      await this.pagePermissionRepo.deletePagePermissionsByGroupIds(
        pageAccess.id,
        groupIds,
        trx,
      );
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('update-permission')
  async updatePagePermissionRole(
    @Body() dto: UpdatePagePermissionRoleDto,
    @AuthUser() user: User,
  ) {
    if ((!dto.userId && !dto.groupId) || (dto.userId && dto.groupId)) {
      throw new BadRequestException('Provide exactly one user or group');
    }

    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);
    const pageAccess = await this.pagePermissionRepo.findPageAccessByPageId(
      page.id,
    );
    if (!pageAccess) {
      throw new NotFoundException('Page restriction not found');
    }

    await this.pagePermissionRepo.updatePagePermissionRole(
      pageAccess.id,
      dto.role,
      { userId: dto.userId, groupId: dto.groupId },
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('labels/add')
  async addPageLabels(
    @Body() dto: AddLabelsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);

    return this.labelService.addLabelsToPage(page.id, dto.names, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('labels/remove')
  async removePageLabel(@Body() dto: RemoveLabelDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanEdit(page, user);

    await this.labelService.removeLabelFromPage(
      page.id,
      dto.labelId,
      page.workspaceId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('backlinks-count')
  async getBacklinksCount(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
  ): Promise<{ incoming: number; outgoing: number }> {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanView(page, user);

    return this.backlinkService.countByPageId(page.id, user.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('backlinks')
  async getBacklinks(
    @Body() dto: BacklinksListDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanView(page, user);

    return this.backlinkService.findByPageId(
      page.id,
      dto.direction,
      user.id,
      pagination,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() createPageDto: CreatePageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    if (createPageDto.parentPageId) {
      // Creating under a parent page - check edit permission on parent
      const parentPage = await this.pageRepo.findById(
        createPageDto.parentPageId,
      );
      if (
        !parentPage ||
        parentPage.deletedAt ||
        parentPage.spaceId !== createPageDto.spaceId
      ) {
        throw new NotFoundException('Parent page not found');
      }
      await this.pageAccessService.validateCanEdit(parentPage, user);
    } else {
      // Creating at root level - require space-level permission
      const ability = await this.spaceAbility.createForUser(
        user,
        createPageDto.spaceId,
      );
      if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    const page = await this.pageService.create(
      user.id,
      workspace.id,
      createPageDto,
    );

    const { canEdit, hasRestriction } =
      await this.pageAccessService.validateCanViewWithPermissions(page, user);

    const permissions = { canEdit, hasRestriction };

    this.auditService.log({
      event: AuditEvent.PAGE_CREATED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      changes: {
        after: {
          title: getPageTitle(page.title),
          spaceId: page.spaceId,
        },
      },
    });

    if (
      createPageDto.format &&
      createPageDto.format !== 'json' &&
      page.content
    ) {
      const contentOutput =
        createPageDto.format === 'markdown'
          ? jsonToMarkdown(page.content)
          : jsonToHtml(page.content);
      return { ...page, content: contentOutput, permissions };
    }

    return { ...page, permissions };
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async update(@Body() updatePageDto: UpdatePageDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(updatePageDto.pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const { hasRestriction } = await this.pageAccessService.validateCanEdit(
      page,
      user,
    );

    const updatedPage = await this.pageService.update(
      page,
      updatePageDto,
      user,
    );

    const permissions = { canEdit: true, hasRestriction };

    if (
      updatePageDto.format &&
      updatePageDto.format !== 'json' &&
      updatedPage.content
    ) {
      const contentOutput =
        updatePageDto.format === 'markdown'
          ? jsonToMarkdown(updatedPage.content)
          : jsonToHtml(updatedPage.content);
      return { ...updatedPage, content: contentOutput, permissions };
    }

    return { ...updatedPage, permissions };
  }

  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async delete(
    @Body() deletePageDto: DeletePageDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(deletePageDto.pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    const ability = await this.spaceAbility.createForUser(user, page.spaceId);

    if (deletePageDto.permanentlyDelete) {
      // Permanent deletion requires space admin permissions
      if (ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)) {
        throw new ForbiddenException(
          'Only space admins can permanently delete pages',
        );
      }
      await this.pageService.forceDelete(deletePageDto.pageId, workspace.id);

      this.auditService.log({
        event: AuditEvent.PAGE_DELETED,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: page.spaceId,
        changes: {
          before: {
            pageId: page.id,
            slugId: page.slugId,
            title: getPageTitle(page.title),
            spaceId: page.spaceId,
          },
        },
      });
    } else {
      // User with edit permission can delete
      await this.pageAccessService.validateCanEdit(page, user);

      await this.pageService.removePage(
        deletePageDto.pageId,
        user.id,
        workspace.id,
      );

      this.auditService.log({
        event: AuditEvent.PAGE_TRASHED,
        resourceType: AuditResource.PAGE,
        resourceId: page.id,
        spaceId: page.spaceId,
        changes: {
          before: {
            pageId: page.id,
            slugId: page.slugId,
            title: getPageTitle(page.title),
            spaceId: page.spaceId,
          },
        },
      });
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('restore')
  async restore(
    @Body() pageIdDto: PageIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(pageIdDto.pageId);

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    // only users with "can edit" space level permission can restore pages
    const ability = await this.spaceAbility.createForUser(user, page.spaceId);
    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    // make sure they have page level access to the page
    await this.pageAccessService.validateCanEdit(page, user);

    await this.pageRepo.restorePage(pageIdDto.pageId, workspace.id);

    this.auditService.log({
      event: AuditEvent.PAGE_RESTORED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      changes: {
        after: {
          title: getPageTitle(page.title),
          spaceId: page.spaceId,
        },
      },
    });

    return this.pageRepo.findById(pageIdDto.pageId, {
      includeHasChildren: true,
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('recent')
  async getRecentPages(
    @Body() recentPageDto: RecentPageDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    if (recentPageDto.spaceId) {
      const ability = await this.spaceAbility.createForUser(
        user,
        recentPageDto.spaceId,
      );

      if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }

      return this.pageService.getRecentSpacePages(
        recentPageDto.spaceId,
        user.id,
        pagination,
      );
    }

    return this.pageService.getRecentPages(user.id, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('created-by-user')
  async getCreatedByPages(
    @Body() dto: CreatedByUserDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const targetUserId = dto.userId ?? user.id;

    if (dto.spaceId) {
      const ability = await this.spaceAbility.createForUser(user, dto.spaceId);

      if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }
    }

    return this.pageService.getCreatedByPages(
      targetUserId,
      user.id,
      pagination,
      dto.spaceId,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('trash')
  async getDeletedPages(
    @Body() deletedPageDto: DeletedPageDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    if (deletedPageDto.spaceId) {
      const ability = await this.spaceAbility.createForUser(
        user,
        deletedPageDto.spaceId,
      );

      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }

      return this.pageService.getDeletedSpacePages(
        deletedPageDto.spaceId,
        user.id,
        pagination,
      );
    }
  }

  @HttpCode(HttpStatus.OK)
  @Post('/history')
  async getPageHistory(
    @Body() dto: PageIdDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return this.pageHistoryService.findHistoryByPageId(page.id, pagination);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/history/info')
  async getPageHistoryInfo(
    @Body() dto: PageHistoryIdDto,
    @AuthUser() user: User,
  ) {
    const history = await this.pageHistoryService.findById(dto.historyId);
    if (!history) {
      throw new NotFoundException('Page history not found');
    }

    // Get the page to check permissions
    const page = await this.pageRepo.findById(history.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return history;
  }

  @HttpCode(HttpStatus.OK)
  @Post('/sidebar-pages')
  async getSidebarPages(
    @Body() dto: SidebarPageDto,
    @Body() pagination: PaginationOptions,
    @AuthUser() user: User,
  ) {
    if (!dto.spaceId && !dto.pageId) {
      throw new BadRequestException(
        'Either spaceId or pageId must be provided',
      );
    }
    let spaceId = dto.spaceId;

    if (dto.pageId) {
      const page = await this.pageRepo.findById(dto.pageId);
      if (!page) {
        throw new ForbiddenException();
      }

      spaceId = page.spaceId;
    }

    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    const spaceCanEdit = ability.can(
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );

    return this.pageService.getSidebarPages(
      spaceId,
      pagination,
      dto.pageId,
      user.role === UserRole.OWNER ? undefined : user.id,
      user.role === UserRole.OWNER ? true : spaceCanEdit,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('move-to-space')
  async movePageToSpace(
    @Body() dto: MovePageToSpaceDto,
    @AuthUser() user: User,
  ) {
    const movedPage = await this.pageRepo.findById(dto.pageId);
    if (!movedPage) {
      throw new NotFoundException('Page to move not found');
    }
    if (movedPage.spaceId === dto.spaceId) {
      throw new BadRequestException('Page is already in this space');
    }

    const abilities = await Promise.all([
      this.spaceAbility.createForUser(user, movedPage.spaceId),
      this.spaceAbility.createForUser(user, dto.spaceId),
    ]);

    if (
      abilities.some((ability) =>
        ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
      )
    ) {
      throw new ForbiddenException();
    }

    // Check page-level edit permission on the source page
    await this.pageAccessService.validateCanEdit(movedPage, user);

    // Moves only accessible pages; inaccessible child pages become root pages in original space
    const { childPageIds } = await this.pageService.movePageToSpace(
      movedPage,
      dto.spaceId,
      user.id,
    );

    this.auditService.log({
      event: AuditEvent.PAGE_MOVED_TO_SPACE,
      resourceType: AuditResource.PAGE,
      resourceId: movedPage.id,
      spaceId: movedPage.spaceId,
      changes: {
        before: { spaceId: movedPage.spaceId },
        after: { spaceId: dto.spaceId },
      },
      metadata: {
        title: getPageTitle(movedPage.title),
        ...(childPageIds.length > 0 && { childPageIds }),
      },
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('duplicate')
  async duplicatePage(@Body() dto: DuplicatePageDto, @AuthUser() user: User) {
    const copiedPage = await this.pageRepo.findById(dto.pageId);
    if (!copiedPage) {
      throw new NotFoundException('Page to copy not found');
    }

    // Check page-level view permission on the source page (need to read to copy)
    // Inaccessible child branches are automatically skipped during duplication
    await this.pageAccessService.validateCanView(copiedPage, user);

    let result;

    // If spaceId is provided, it's a copy to different space
    if (dto.spaceId) {
      const abilities = await Promise.all([
        this.spaceAbility.createForUser(user, copiedPage.spaceId),
        this.spaceAbility.createForUser(user, dto.spaceId),
      ]);

      if (
        abilities.some((ability) =>
          ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
        )
      ) {
        throw new ForbiddenException();
      }

      result = await this.pageService.duplicatePage(
        copiedPage,
        dto.spaceId,
        user,
      );

      this.auditService.log({
        event: AuditEvent.PAGE_DUPLICATED,
        resourceType: AuditResource.PAGE,
        resourceId: result.id,
        spaceId: dto.spaceId,
        metadata: {
          sourcePageId: copiedPage.id,
          title: getPageTitle(copiedPage.title),
          sourceSpaceId: copiedPage.spaceId,
          targetSpaceId: dto.spaceId,
          ...(result.childPageIds.length > 0 && {
            childPageIds: result.childPageIds,
          }),
        },
      });
    } else {
      // If no spaceId, it's a duplicate in same space
      const ability = await this.spaceAbility.createForUser(
        user,
        copiedPage.spaceId,
      );
      if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
        throw new ForbiddenException();
      }

      result = await this.pageService.duplicatePage(
        copiedPage,
        undefined,
        user,
      );

      this.auditService.log({
        event: AuditEvent.PAGE_DUPLICATED,
        resourceType: AuditResource.PAGE,
        resourceId: result.id,
        spaceId: copiedPage.spaceId,
        metadata: {
          sourcePageId: copiedPage.id,
          title: getPageTitle(copiedPage.title),
          ...(result.childPageIds.length > 0 && {
            childPageIds: result.childPageIds,
          }),
        },
      });
    }

    return result;
  }

  @HttpCode(HttpStatus.OK)
  @Post('move')
  async movePage(@Body() dto: MovePageDto, @AuthUser() user: User) {
    const movedPage = await this.pageRepo.findById(dto.pageId);
    if (!movedPage) {
      throw new NotFoundException('Moved page not found');
    }

    const ability = await this.spaceAbility.createForUser(
      user,
      movedPage.spaceId,
    );

    if (ability.cannot(SpaceCaslAction.Edit, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }

    // Check page-level edit permission
    await this.pageAccessService.validateCanEdit(movedPage, user);

    // If moving to a new parent, check permission on the target parent
    if (dto.parentPageId && dto.parentPageId !== movedPage.parentPageId) {
      const targetParent = await this.pageRepo.findById(dto.parentPageId);
      if (!targetParent || targetParent.deletedAt) {
        throw new NotFoundException('Target parent page not found');
      }
      await this.pageAccessService.validateCanEdit(targetParent, user);
    }

    return this.pageService.movePage(dto, movedPage);
  }

  @HttpCode(HttpStatus.OK)
  @Post('/breadcrumbs')
  async getPageBreadcrumbs(@Body() dto: PageIdDto, @AuthUser() user: User) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }

    await this.pageAccessService.validateCanView(page, user);

    return this.pageService.getPageBreadCrumbs(page.id);
  }
}
