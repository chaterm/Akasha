import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';
import { UserRole, SpaceRole } from '../../common/helpers/types/permission';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { PagePermissionRepo } from '@akasha/db/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { SpaceMemberService } from '../space/services/space-member.service';
import { SpaceService } from '../space/services/space.service';
import { PageService } from '../page/services/page.service';
import { SearchService } from '../search/search.service';
import { CommentService } from '../comment/comment.service';
import { CommentRepo } from '@akasha/db/repos/comment/comment.repo';
import { WorkspaceService } from '../workspace/services/workspace.service';
import { PageAccessService } from '../page/page-access/page-access.service';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { findHighestUserSpaceRole } from '@akasha/db/repos/space/utils';
import { CreateCommentDto } from '../comment/dto/create-comment.dto';
import { UpdateCommentDto } from '../comment/dto/update-comment.dto';
import { CreatePageDto, ContentFormat } from '../page/dto/create-page.dto';
import { UpdatePageDto } from '../page/dto/update-page.dto';
import { MovePageDto } from '../page/dto/move-page.dto';
import { CreateSpaceDto } from '../space/dto/create-space.dto';
import { UpdateSpaceDto } from '../space/dto/update-space.dto';
import {
  jsonToHtml,
  jsonToMarkdown,
} from '../../collaboration/collaboration.util';

type ToolContext = {
  user: User;
  workspace: Workspace;
};

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const paginationSchema = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  beforeCursor: z.string().optional(),
};

const contentFormatSchema = z.enum(['json', 'markdown', 'html']).optional();

@Injectable()
export class McpService {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly pageService: PageService,
    private readonly pageAccessService: PageAccessService,
    private readonly searchService: SearchService,
    private readonly spaceService: SpaceService,
    private readonly spaceMemberService: SpaceMemberService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly commentService: CommentService,
    private readonly commentRepo: CommentRepo,
    private readonly workspaceService: WorkspaceService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  assertEnabled(workspace: Workspace) {
    const settings = (workspace.settings ?? {}) as Record<string, any>;
    if (settings?.ai?.mcp !== true) {
      throw new ForbiddenException('MCP is disabled for this workspace');
    }
  }

  async handleRequest(
    ctx: ToolContext,
    req: any,
    res: any,
    parsedBody: unknown,
  ) {
    const server = this.createServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  private createServer(ctx: ToolContext): McpServer {
    const server = new McpServer({
      name: 'akasha-mcp',
      version: '0.1.0',
    });

    server.registerTool(
      'search_pages',
      {
        title: 'Search pages',
        description: 'Search workspace pages the current API key can access.',
        inputSchema: {
          query: z.string().min(1),
          spaceId: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          offset: z.number().int().min(0).optional(),
        },
      },
      (args) => this.runTool(() => this.searchPages(ctx, args)),
    );

    server.registerTool(
      'get_page',
      {
        title: 'Get page',
        description: 'Get a page by id or slug id.',
        inputSchema: {
          pageId: z.string().min(1),
          format: contentFormatSchema,
        },
      },
      (args) => this.runTool(() => this.getPage(ctx, args)),
    );

    server.registerTool(
      'create_page',
      {
        title: 'Create page',
        description: 'Create a page in a space or below a parent page.',
        inputSchema: {
          spaceId: z.string().min(1),
          title: z.string().optional(),
          icon: z.string().optional(),
          parentPageId: z.string().optional(),
          content: z.any().optional(),
          format: contentFormatSchema,
        },
      },
      (args) => this.runTool(() => this.createPage(ctx, args)),
    );

    server.registerTool(
      'update_page',
      {
        title: 'Update page',
        description: 'Update page metadata and optionally append, prepend, or replace content.',
        inputSchema: {
          pageId: z.string().min(1),
          title: z.string().optional(),
          icon: z.string().optional(),
          content: z.any().optional(),
          operation: z.enum(['append', 'prepend', 'replace']).optional(),
          format: contentFormatSchema,
        },
      },
      (args) => this.runTool(() => this.updatePage(ctx, args)),
    );

    server.registerTool(
      'list_pages',
      {
        title: 'List root pages',
        description: 'List root pages in a space.',
        inputSchema: {
          spaceId: z.string().min(1),
          ...paginationSchema,
        },
      },
      (args) => this.runTool(() => this.listPages(ctx, args)),
    );

    server.registerTool(
      'list_child_pages',
      {
        title: 'List child pages',
        description: 'List child pages below a parent page.',
        inputSchema: {
          pageId: z.string().min(1),
          ...paginationSchema,
        },
      },
      (args) => this.runTool(() => this.listChildPages(ctx, args)),
    );

    server.registerTool(
      'duplicate_page',
      {
        title: 'Duplicate page',
        description: 'Duplicate a page in its current space.',
        inputSchema: { pageId: z.string().min(1) },
      },
      (args) => this.runTool(() => this.duplicatePage(ctx, args)),
    );

    server.registerTool(
      'copy_page_to_space',
      {
        title: 'Copy page to space',
        description: 'Copy a page and accessible descendants to another space.',
        inputSchema: {
          pageId: z.string().min(1),
          spaceId: z.string().min(1),
        },
      },
      (args) => this.runTool(() => this.copyPageToSpace(ctx, args)),
    );

    server.registerTool(
      'move_page',
      {
        title: 'Move page',
        description: 'Move or reorder a page within its current space.',
        inputSchema: {
          pageId: z.string().min(1),
          position: z.string().min(5).max(12),
          parentPageId: z.string().nullable().optional(),
        },
      },
      (args) => this.runTool(() => this.movePage(ctx, args)),
    );

    server.registerTool(
      'move_page_to_space',
      {
        title: 'Move page to space',
        description: 'Move a page and accessible descendants to another space.',
        inputSchema: {
          pageId: z.string().min(1),
          spaceId: z.string().min(1),
        },
      },
      (args) => this.runTool(() => this.movePageToSpace(ctx, args)),
    );

    server.registerTool(
      'get_space',
      {
        title: 'Get space',
        description: 'Get a space by id.',
        inputSchema: { spaceId: z.string().min(1) },
      },
      (args) => this.runTool(() => this.getSpace(ctx, args)),
    );

    server.registerTool(
      'list_spaces',
      {
        title: 'List spaces',
        description: 'List spaces the current API key can access.',
        inputSchema: paginationSchema,
      },
      (args) => this.runTool(() => this.listSpaces(ctx, args)),
    );

    server.registerTool(
      'create_space',
      {
        title: 'Create space',
        description: 'Create a workspace space.',
        inputSchema: {
          name: z.string().min(1),
          slug: z.string().min(1),
          description: z.string().optional(),
        },
      },
      (args) => this.runTool(() => this.createSpace(ctx, args)),
    );

    server.registerTool(
      'update_space',
      {
        title: 'Update space',
        description: 'Update space name, slug, or description.',
        inputSchema: {
          spaceId: z.string().min(1),
          name: z.string().optional(),
          slug: z.string().optional(),
          description: z.string().optional(),
        },
      },
      (args) => this.runTool(() => this.updateSpace(ctx, args)),
    );

    server.registerTool(
      'get_comments',
      {
        title: 'Get comments',
        description: 'List comments on a page.',
        inputSchema: {
          pageId: z.string().min(1),
          ...paginationSchema,
        },
      },
      (args) => this.runTool(() => this.getComments(ctx, args)),
    );

    server.registerTool(
      'create_comment',
      {
        title: 'Create comment',
        description: 'Create a page or inline comment.',
        inputSchema: {
          pageId: z.string().min(1),
          content: z.any(),
          selection: z.string().optional(),
          type: z.enum(['inline', 'page']).optional(),
          parentCommentId: z.string().optional(),
        },
      },
      (args) => this.runTool(() => this.createComment(ctx, args)),
    );

    server.registerTool(
      'update_comment',
      {
        title: 'Update comment',
        description: 'Update a comment owned by the current API key user.',
        inputSchema: {
          commentId: z.string().min(1),
          content: z.any(),
        },
      },
      (args) => this.runTool(() => this.updateComment(ctx, args)),
    );

    server.registerTool(
      'search_attachments',
      {
        title: 'Search attachments',
        description: 'Search page attachments by filename or indexed text.',
        inputSchema: {
          query: z.string().min(1),
          spaceId: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
      },
      (args) => this.runTool(() => this.searchAttachments(ctx, args)),
    );

    server.registerTool(
      'list_workspace_members',
      {
        title: 'List workspace members',
        description: 'List workspace members visible to the current API key user.',
        inputSchema: {
          query: z.string().optional(),
          ...paginationSchema,
        },
      },
      (args) => this.runTool(() => this.listWorkspaceMembers(ctx, args)),
    );

    server.registerTool(
      'get_current_user',
      {
        title: 'Get current user',
        description: 'Get the current API key user and workspace.',
      },
      () => this.runTool(() => this.getCurrentUser(ctx)),
    );

    return server;
  }

  private async searchPages(
    ctx: ToolContext,
    args: { query: string; spaceId?: string; limit?: number; offset?: number },
  ) {
    if (args.spaceId) {
      await this.requireSpaceAbility(
        ctx.user,
        args.spaceId,
        SpaceCaslAction.Read,
        SpaceCaslSubject.Page,
      );
    }

    return this.searchService.searchPage(
      {
        query: args.query,
        spaceId: args.spaceId,
        limit: args.limit,
        offset: args.offset,
      },
      { userId: ctx.user.id, workspaceId: ctx.workspace.id },
    );
  }

  private async getPage(
    ctx: ToolContext,
    args: { pageId: string; format?: ContentFormat },
  ) {
    const page = await this.pageRepo.findById(args.pageId, {
      includeSpace: true,
      includeContent: true,
      includeCreator: true,
      includeLastUpdatedBy: true,
      includeContributors: true,
      includeDeletedBy: true,
    });
    if (!page || page.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Page not found');
    }

    const permissions =
      await this.pageAccessService.validateCanViewWithPermissions(
        page,
        ctx.user,
      );

    return this.formatPageContent(page, args.format, permissions);
  }

  private async createPage(
    ctx: ToolContext,
    args: {
      spaceId: string;
      title?: string;
      icon?: string;
      parentPageId?: string;
      content?: any;
      format?: ContentFormat;
    },
  ) {
    if (args.parentPageId) {
      const parentPage = await this.pageRepo.findById(args.parentPageId);
      if (
        !parentPage ||
        parentPage.deletedAt ||
        parentPage.spaceId !== args.spaceId ||
        parentPage.workspaceId !== ctx.workspace.id
      ) {
        throw new NotFoundException('Parent page not found');
      }
      await this.pageAccessService.validateCanEdit(parentPage, ctx.user);
    } else {
      await this.requireSpaceAbility(
        ctx.user,
        args.spaceId,
        SpaceCaslAction.Create,
        SpaceCaslSubject.Page,
      );
    }

    const dto: CreatePageDto = {
      spaceId: args.spaceId,
      title: args.title,
      icon: args.icon,
      parentPageId: args.parentPageId,
      content: args.content,
      format: this.contentFormatFor(args.content, args.format),
    };
    const page = await this.pageService.create(ctx.user.id, ctx.workspace.id, dto);
    const permissions =
      await this.pageAccessService.validateCanViewWithPermissions(
        page,
        ctx.user,
      );

    return this.formatPageContent(page, args.format, permissions);
  }

  private async updatePage(
    ctx: ToolContext,
    args: {
      pageId: string;
      title?: string;
      icon?: string;
      content?: any;
      operation?: 'append' | 'prepend' | 'replace';
      format?: ContentFormat;
    },
  ) {
    const page = await this.pageRepo.findById(args.pageId);
    if (!page || page.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Page not found');
    }

    const { hasRestriction } = await this.pageAccessService.validateCanEdit(
      page,
      ctx.user,
    );
    if (args.content !== undefined && !args.operation) {
      throw new BadRequestException('operation is required when content is provided');
    }

    const dto: UpdatePageDto = {
      pageId: args.pageId,
      title: args.title,
      icon: args.icon,
      content: args.content,
      operation: args.operation,
      format: this.contentFormatFor(args.content, args.format),
    };
    const updatedPage = await this.pageService.update(page, dto, ctx.user);
    return this.formatPageContent(updatedPage, args.format, {
      canEdit: true,
      hasRestriction,
    });
  }

  private async listPages(
    ctx: ToolContext,
    args: { spaceId: string; limit?: number; cursor?: string; beforeCursor?: string },
  ) {
    const ability = await this.requireSpaceAbility(
      ctx.user,
      args.spaceId,
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
    return this.pageService.getSidebarPages(
      args.spaceId,
      this.pagination(args),
      undefined,
      ctx.user.role === UserRole.OWNER ? undefined : ctx.user.id,
      ctx.user.role === UserRole.OWNER
        ? true
        : ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
    );
  }

  private async listChildPages(
    ctx: ToolContext,
    args: { pageId: string; limit?: number; cursor?: string; beforeCursor?: string },
  ) {
    const page = await this.pageRepo.findById(args.pageId);
    if (!page || page.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanView(page, ctx.user);

    const ability = await this.requireSpaceAbility(
      ctx.user,
      page.spaceId,
      SpaceCaslAction.Read,
      SpaceCaslSubject.Page,
    );
    return this.pageService.getSidebarPages(
      page.spaceId,
      this.pagination(args),
      page.id,
      ctx.user.role === UserRole.OWNER ? undefined : ctx.user.id,
      ctx.user.role === UserRole.OWNER
        ? true
        : ability.can(SpaceCaslAction.Edit, SpaceCaslSubject.Page),
    );
  }

  private async duplicatePage(ctx: ToolContext, args: { pageId: string }) {
    return this.copyPage(ctx, args.pageId);
  }

  private async copyPageToSpace(
    ctx: ToolContext,
    args: { pageId: string; spaceId: string },
  ) {
    return this.copyPage(ctx, args.pageId, args.spaceId);
  }

  private async movePage(
    ctx: ToolContext,
    args: { pageId: string; position: string; parentPageId?: string | null },
  ) {
    const movedPage = await this.pageRepo.findById(args.pageId);
    if (!movedPage || movedPage.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Moved page not found');
    }

    await this.requireSpaceAbility(
      ctx.user,
      movedPage.spaceId,
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );
    await this.pageAccessService.validateCanEdit(movedPage, ctx.user);

    if (args.parentPageId && args.parentPageId !== movedPage.parentPageId) {
      const targetParent = await this.pageRepo.findById(args.parentPageId);
      if (
        !targetParent ||
        targetParent.deletedAt ||
        targetParent.workspaceId !== ctx.workspace.id
      ) {
        throw new NotFoundException('Target parent page not found');
      }
      await this.pageAccessService.validateCanEdit(targetParent, ctx.user);
    }

    const dto: MovePageDto = {
      pageId: args.pageId,
      position: args.position,
      parentPageId: args.parentPageId,
    };
    await this.pageService.movePage(dto, movedPage);
    return { success: true };
  }

  private async movePageToSpace(
    ctx: ToolContext,
    args: { pageId: string; spaceId: string },
  ) {
    const movedPage = await this.pageRepo.findById(args.pageId);
    if (!movedPage || movedPage.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Page to move not found');
    }
    if (movedPage.spaceId === args.spaceId) {
      throw new BadRequestException('Page is already in this space');
    }

    await Promise.all([
      this.requireSpaceAbility(
        ctx.user,
        movedPage.spaceId,
        SpaceCaslAction.Edit,
        SpaceCaslSubject.Page,
      ),
      this.requireSpaceAbility(
        ctx.user,
        args.spaceId,
        SpaceCaslAction.Edit,
        SpaceCaslSubject.Page,
      ),
    ]);
    await this.pageAccessService.validateCanEdit(movedPage, ctx.user);

    return this.pageService.movePageToSpace(movedPage, args.spaceId, ctx.user.id);
  }

  private async getSpace(ctx: ToolContext, args: { spaceId: string }) {
    const space = await this.spaceService.getSpaceInfo(
      args.spaceId,
      ctx.workspace.id,
    );
    await this.requireSpaceAbility(
      ctx.user,
      space.id,
      SpaceCaslAction.Read,
      SpaceCaslSubject.Settings,
    );
    return space;
  }

  private async listSpaces(
    ctx: ToolContext,
    args: { limit?: number; cursor?: string; beforeCursor?: string },
  ) {
    if (ctx.user.role === UserRole.OWNER) {
      const result = await this.spaceService.getWorkspaceSpaces(
        ctx.workspace.id,
        this.pagination(args),
      );
      result.items = result.items.map((space) => ({
        ...space,
        membership: { userId: ctx.user.id, role: SpaceRole.ADMIN },
      }));
      return result;
    }

    const result = await this.spaceMemberService.getUserSpaces(
      ctx.user.id,
      this.pagination(args),
    );
    if (result.items.length === 0) {
      return result;
    }

    const spaceIds = result.items.map((s) => s.id);
    const roles = await this.spaceMemberRepo.getUserRolesForSpaces(
      ctx.user.id,
      spaceIds,
    );
    const roleMap = new Map<string, string[]>();
    for (const row of roles) {
      const existing = roleMap.get(row.spaceId) || [];
      existing.push(row.role);
      roleMap.set(row.spaceId, existing);
    }

    result.items = result.items.map((space) => {
      const spaceRoles = roleMap.get(space.id);
      return {
        ...space,
        membership: {
          userId: ctx.user.id,
          role: spaceRoles
            ? findHighestUserSpaceRole(
                spaceRoles.map((role) => ({ userId: ctx.user.id, role })),
              )
            : undefined,
        },
      };
    });
    return result;
  }

  private async createSpace(
    ctx: ToolContext,
    args: { name: string; slug: string; description?: string },
  ) {
    this.requireWorkspaceAbility(
      ctx.user,
      ctx.workspace,
      WorkspaceCaslAction.Manage,
      WorkspaceCaslSubject.Space,
    );
    return this.spaceService.createSpace(ctx.user, ctx.workspace.id, {
      name: args.name,
      slug: args.slug,
      description: args.description,
    } as CreateSpaceDto);
  }

  private async updateSpace(
    ctx: ToolContext,
    args: { spaceId: string; name?: string; slug?: string; description?: string },
  ) {
    await this.requireSpaceAbility(
      ctx.user,
      args.spaceId,
      SpaceCaslAction.Manage,
      SpaceCaslSubject.Settings,
    );
    return this.spaceService.updateSpace(args as UpdateSpaceDto, ctx.workspace.id);
  }

  private async getComments(
    ctx: ToolContext,
    args: { pageId: string; limit?: number; cursor?: string; beforeCursor?: string },
  ) {
    const page = await this.pageRepo.findById(args.pageId);
    if (!page || page.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanView(page, ctx.user);
    return this.commentService.findByPageId(page.id, this.pagination(args));
  }

  private async createComment(
    ctx: ToolContext,
    args: {
      pageId: string;
      content: any;
      selection?: string;
      type?: string;
      parentCommentId?: string;
    },
  ) {
    const page = await this.pageRepo.findById(args.pageId);
    if (!page || page.deletedAt || page.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanComment(
      page,
      ctx.user,
      ctx.workspace.id,
    );

    const dto: CreateCommentDto = {
      pageId: page.id,
      content: this.jsonString(args.content),
      selection: args.selection,
      type: args.type,
      parentCommentId: args.parentCommentId,
    };
    return this.commentService.create(
      { page, workspaceId: ctx.workspace.id, user: ctx.user },
      dto,
    );
  }

  private async updateComment(
    ctx: ToolContext,
    args: { commentId: string; content: any },
  ) {
    const comment = await this.commentRepo.findById(args.commentId, {
      includeCreator: true,
      includeResolvedBy: true,
    });
    if (!comment || comment.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Comment not found');
    }

    const page = await this.pageRepo.findById(comment.pageId);
    if (!page) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanComment(
      page,
      ctx.user,
      ctx.workspace.id,
    );

    const dto: UpdateCommentDto = {
      commentId: args.commentId,
      content: this.jsonString(args.content),
    };
    return this.commentService.update(comment, dto, ctx.user);
  }

  private async searchAttachments(
    ctx: ToolContext,
    args: { query: string; spaceId?: string; limit?: number },
  ) {
    if (args.spaceId) {
      await this.requireSpaceAbility(
        ctx.user,
        args.spaceId,
        SpaceCaslAction.Read,
        SpaceCaslSubject.Page,
      );
    }

    const query = `%${args.query.trim()}%`;
    let attachmentsQuery = this.db
      .selectFrom('attachments')
      .select([
        'id',
        'fileName',
        'fileSize',
        'fileExt',
        'mimeType',
        'type',
        'creatorId',
        'pageId',
        'spaceId',
        'workspaceId',
        'createdAt',
        'updatedAt',
      ])
      .where('workspaceId', '=', ctx.workspace.id)
      .where('deletedAt', 'is', null)
      .where('pageId', 'is not', null)
      .where((eb) =>
        eb.or([
          eb('fileName', 'ilike', query),
          eb(sql`COALESCE(text_content, '')`, 'ilike', query),
        ]),
      )
      .limit(args.limit ?? 25);

    if (args.spaceId) {
      attachmentsQuery = attachmentsQuery.where('spaceId', '=', args.spaceId);
    } else if (ctx.user.role !== UserRole.OWNER) {
      attachmentsQuery = attachmentsQuery.where(
        'spaceId',
        'in',
        this.spaceMemberRepo.getUserSpaceIdsQuery(ctx.user.id),
      );
    }

    let attachments = await attachmentsQuery.execute();
    if (attachments.length === 0) {
      return { items: [] };
    }

    const pageIds = attachments
      .map((attachment) => attachment.pageId)
      .filter(Boolean);
    const accessibleIds =
      await this.pagePermissionRepo.filterAccessiblePageIds({
        pageIds,
        userId: ctx.user.id,
        spaceId: args.spaceId,
      });
    const accessibleSet = new Set(accessibleIds);
    attachments = attachments.filter((attachment) =>
      accessibleSet.has(attachment.pageId),
    );

    return { items: attachments };
  }

  private async listWorkspaceMembers(
    ctx: ToolContext,
    args: {
      query?: string;
      limit?: number;
      cursor?: string;
      beforeCursor?: string;
    },
  ) {
    this.requireWorkspaceAbility(
      ctx.user,
      ctx.workspace,
      WorkspaceCaslAction.Read,
      WorkspaceCaslSubject.Member,
    );
    return this.workspaceService.getWorkspaceUsers(ctx.workspace.id, {
      ...this.pagination(args),
      query: args.query,
    });
  }

  private async getCurrentUser(ctx: ToolContext) {
    return {
      user: ctx.user,
      workspace: {
        id: ctx.workspace.id,
        name: ctx.workspace.name,
        hostname: ctx.workspace.hostname,
        plan: ctx.workspace.plan,
        settings: ctx.workspace.settings,
      },
    };
  }

  private async copyPage(
    ctx: ToolContext,
    pageId: string,
    targetSpaceId?: string,
  ) {
    const copiedPage = await this.pageRepo.findById(pageId);
    if (!copiedPage || copiedPage.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Page to copy not found');
    }

    await this.pageAccessService.validateCanView(copiedPage, ctx.user);

    if (targetSpaceId) {
      await Promise.all([
        this.requireSpaceAbility(
          ctx.user,
          copiedPage.spaceId,
          SpaceCaslAction.Edit,
          SpaceCaslSubject.Page,
        ),
        this.requireSpaceAbility(
          ctx.user,
          targetSpaceId,
          SpaceCaslAction.Edit,
          SpaceCaslSubject.Page,
        ),
      ]);
    } else {
      await this.requireSpaceAbility(
        ctx.user,
        copiedPage.spaceId,
        SpaceCaslAction.Edit,
        SpaceCaslSubject.Page,
      );
    }

    return this.pageService.duplicatePage(copiedPage, targetSpaceId, ctx.user);
  }

  private async requireSpaceAbility(
    user: User,
    spaceId: string,
    action: SpaceCaslAction,
    subject: SpaceCaslSubject,
  ) {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(action, subject)) {
      throw new ForbiddenException();
    }
    return ability;
  }

  private requireWorkspaceAbility(
    user: User,
    workspace: Workspace,
    action: WorkspaceCaslAction,
    subject: WorkspaceCaslSubject,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (ability.cannot(action, subject)) {
      throw new ForbiddenException();
    }
    return ability;
  }

  private async runTool(fn: () => Promise<unknown>): Promise<ToolResult> {
    try {
      return this.textResult(await fn());
    } catch (err: any) {
      return this.textResult(
        {
          error: err?.response?.message ?? err?.message ?? 'Tool failed',
          statusCode: err?.status ?? err?.statusCode,
        },
        true,
      );
    }
  }

  private textResult(value: unknown, isError = false): ToolResult {
    return {
      isError: isError || undefined,
      content: [
        {
          type: 'text',
          text: JSON.stringify(value, null, 2),
        },
      ],
    };
  }

  private pagination(args: {
    limit?: number;
    cursor?: string;
    beforeCursor?: string;
  }): PaginationOptions {
    return {
      limit: args.limit ?? 20,
      cursor: args.cursor,
      beforeCursor: args.beforeCursor,
    } as PaginationOptions;
  }

  private contentFormatFor(content: unknown, format?: ContentFormat) {
    if (content === undefined) {
      return undefined;
    }
    return format ?? 'json';
  }

  private async formatPageContent(
    page: any,
    format: ContentFormat | undefined,
    permissions: { canEdit: boolean; hasRestriction: boolean },
  ) {
    if (format && format !== 'json' && page.content) {
      const content =
        format === 'markdown'
          ? jsonToMarkdown(page.content)
          : jsonToHtml(page.content);
      return { ...page, content, permissions };
    }
    return { ...page, permissions };
  }

  private jsonString(value: unknown): string {
    if (typeof value === 'string') {
      JSON.parse(value);
      return value;
    }
    return JSON.stringify(value);
  }
}
