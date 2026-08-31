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
import {
  jsonToHtml,
  jsonToMarkdown,
} from '../../collaboration/collaboration.util';
import { McpToolContext, McpToolRegistry } from './mcp-tool-registry';
import { McpDisabledException } from './mcp.errors';
import { getApiKeyAccess } from '../../common/auth/api-key-access';
import { getPageTitle } from '../../common/helpers';
import { AttachmentService } from '../attachment/services/attachment.service';
import { AttachmentRepo } from '@akasha/db/repos/attachment/attachment.repo';
import { Readable } from 'stream';

type ToolContext = McpToolContext;

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const paginationSchema = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Items per page; defaults to 20.'),
  cursor: z
    .string()
    .optional()
    .describe('Use meta.nextCursor from the previous page to continue.'),
  beforeCursor: z.string().optional().describe('Cursor for paging backwards.'),
};

const contentFormatSchema = z
  .enum(['json', 'markdown', 'html'])
  .optional()
  .describe(
    'Content representation. Omitted content is returned or parsed as JSON.',
  );

const citationPageSegment = /\/p\/([^\/?#\s]+)/;
const citationSlugId = /^[0-9A-Za-z]{10}$/;
const citationUuid =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
    private readonly toolRegistry: McpToolRegistry,
    private readonly attachmentService: AttachmentService,
    private readonly attachmentRepo: AttachmentRepo,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  assertEnabled(workspace: Workspace) {
    const settings = (workspace.settings ?? {}) as Record<string, any>;
    if (settings?.ai?.mcp !== true) {
      throw new McpDisabledException();
    }
  }

  async handleRequest(
    ctx: McpToolContext,
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

  private createServer(ctx: McpToolContext): McpServer {
    const server = new McpServer(
      {
        name: 'akasha-mcp',
        version: '0.1.0',
      },
      {
        instructions:
          'Akasha is a company and personal knowledge base. Use the query_knowledge tool when the answer may require information outside general model knowledge, including information that may exist in this knowledge base. Clearly stable general knowledge and simple calculations do not require a search. Base knowledge-base facts on returned citations and evidence.',
      },
    );

    server.registerTool(
      'search_pages',
      {
        title: 'Search pages',
        description: 'Search workspace pages the current API key can access.',
        inputSchema: {
          query: z.string().min(1).describe('Full-text or title search query.'),
          spaceId: z
            .string()
            .optional()
            .describe('Restrict results to this accessible space.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Maximum results; defaults to the service default.'),
          offset: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              'Zero-based offset; search_pages uses offset, not cursor pagination.',
            ),
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
          pageId: z
            .string()
            .min(1)
            .describe('Page UUID or slug id obtained from another Tool.'),
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
          spaceId: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Target accessible space; omitted uses the current user personal space.',
            ),
          title: z.string().optional().describe('Page title.'),
          icon: z.string().optional().describe('Optional page icon.'),
          parentPageId: z
            .string()
            .optional()
            .describe('Optional accessible parent page in the same space.'),
          content: z
            .any()
            .optional()
            .describe(
              'JSON document, or content matching the selected format.',
            ),
          format: contentFormatSchema,
        },
      },
      (args) => this.runTool(() => this.createPage(ctx, args)),
    );

    server.registerTool(
      'update_page',
      {
        title: 'Update page',
        description:
          'Update page metadata and optionally append, prepend, or replace content.',
        inputSchema: {
          pageId: z
            .string()
            .min(1)
            .describe('Page UUID obtained from another Tool.'),
          title: z.string().optional().describe('New page title.'),
          icon: z.string().optional().describe('New page icon.'),
          content: z
            .any()
            .optional()
            .describe('Content to apply; requires operation.'),
          operation: z
            .enum(['append', 'prepend', 'replace'])
            .optional()
            .describe('Required with content: append, prepend, or replace.'),
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
          spaceId: z.string().min(1).describe('Accessible space UUID.'),
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
          pageId: z.string().min(1).describe('Parent page UUID.'),
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
        inputSchema: {
          pageId: z.string().min(1).describe('Page UUID to duplicate.'),
        },
      },
      (args) => this.runTool(() => this.duplicatePage(ctx, args)),
    );

    server.registerTool(
      'copy_page_to_space',
      {
        title: 'Copy page to space',
        description: 'Copy a page and accessible descendants to another space.',
        inputSchema: {
          pageId: z.string().min(1).describe('Page UUID to copy.'),
          spaceId: z
            .string()
            .min(1)
            .describe('Destination accessible space UUID.'),
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
          pageId: z
            .string()
            .min(1)
            .describe('Page UUID obtained from another Tool.'),
          position: z
            .string()
            .min(5)
            .max(12)
            .describe(
              'Valid 5-12 character page ordering key, not natural-language text.',
            ),
          parentPageId: z
            .string()
            .nullable()
            .optional()
            .describe('New parent page UUID, or null for a root page.'),
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
          pageId: z.string().min(1).describe('Page UUID to move.'),
          spaceId: z
            .string()
            .min(1)
            .describe('Destination accessible space UUID.'),
        },
      },
      (args) => this.runTool(() => this.movePageToSpace(ctx, args)),
    );

    server.registerTool(
      'get_space',
      {
        title: 'Get space',
        description: 'Get a space by id.',
        inputSchema: {
          spaceId: z.string().min(1).describe('Accessible space UUID.'),
        },
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
      'get_comments',
      {
        title: 'Get comments',
        description: 'List comments on a page.',
        inputSchema: {
          pageId: z.string().min(1).describe('Page UUID.'),
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
          pageId: z
            .string()
            .min(1)
            .describe('Page UUID obtained from another Tool.'),
          content: z
            .any()
            .describe(
              'JSON object/array or JSON-encoded string; do not send unencoded plain text.',
            ),
          selection: z
            .string()
            .optional()
            .describe('Selection payload required for inline comments.'),
          type: z
            .enum(['inline', 'page'])
            .optional()
            .describe('Comment kind; defaults to the service default.'),
          parentCommentId: z
            .string()
            .optional()
            .describe('Existing comment UUID when replying.'),
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
          commentId: z
            .string()
            .min(1)
            .describe('Comment UUID obtained from get_comments.'),
          content: z
            .any()
            .describe(
              'JSON object/array or JSON-encoded string; do not send unencoded plain text.',
            ),
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
          query: z
            .string()
            .min(1)
            .describe('Filename or indexed-text search query.'),
          spaceId: z
            .string()
            .optional()
            .describe('Restrict results to this accessible space.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Maximum results; defaults to 25.'),
        },
      },
      (args) => this.runTool(() => this.searchAttachments(ctx, args)),
    );

    server.registerTool(
      'list_workspace_members',
      {
        title: 'List workspace members',
        description:
          'List workspace members visible to the current API key user.',
        inputSchema: {
          query: z
            .string()
            .optional()
            .describe('Optional member name or email filter.'),
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

    server.registerTool(
      'get_citation_page',
      {
        title: 'Get citation page',
        description:
          'Read an ACL-authorized Page from an Akasha /p/<slug> URL.',
        inputSchema: {
          pageUrl: z
            .string()
            .min(1)
            .describe('Akasha /p/<slug> path or full page URL.'),
        },
      },
      (args) => this.runTool(() => this.getCitationPage(ctx, args)),
    );
    server.registerTool(
      'delete_page',
      {
        title: 'Move personal page to trash',
        description: 'Soft-delete a Page in the current user personal space.',
        inputSchema: {
          pageId: z.string().min(1).describe('Personal-space page UUID.'),
        },
      },
      (args) => this.runTool(() => this.deletePersonalPage(ctx, args)),
    );
    server.registerTool(
      'restore_page',
      {
        title: 'Restore personal page',
        description:
          'Restore a Page from the current user personal-space trash.',
        inputSchema: {
          pageId: z
            .string()
            .min(1)
            .describe('Deleted personal-space page UUID.'),
        },
      },
      (args) => this.runTool(() => this.restorePersonalPage(ctx, args)),
    );
    server.registerTool(
      'list_recent_pages',
      {
        title: 'List recent personal pages',
        description:
          'List recently updated Pages in the current user personal space.',
        inputSchema: paginationSchema,
      },
      (args) => this.runTool(() => this.listRecentPersonalPages(ctx, args)),
    );
    server.registerTool(
      'list_trash_pages',
      {
        title: 'List personal page trash',
        description: 'List deleted Pages in the current user personal space.',
        inputSchema: paginationSchema,
      },
      (args) => this.runTool(() => this.listTrashPersonalPages(ctx, args)),
    );
    server.registerTool(
      'get_attachment_info',
      {
        title: 'Get attachment info',
        description:
          'Get metadata and an ACL-authorized download URL for a Page attachment. The Agent fetches the bytes locally from the URL.',
        inputSchema: {
          attachmentId: z.string().min(1).describe('Attachment UUID.'),
        },
      },
      (args) => this.runTool(() => this.getAttachmentInfo(ctx, args)),
    );
    server.registerTool(
      'download_attachment',
      {
        title: 'Download Page attachment',
        description:
          'Resolve an ACL-authorized Page attachment download URL. The Agent fetches the bytes locally from the returned URL.',
        inputSchema: {
          attachmentId: z.string().min(1).describe('Attachment UUID.'),
        },
      },
      (args) => this.runTool(() => this.downloadAttachment(ctx, args)),
    );
    server.registerTool(
      'upload_attachment',
      {
        title: 'Upload Page attachment',
        description: 'Upload a bounded Base64 file to an ACL-authorized Page.',
        inputSchema: {
          pageId: z
            .string()
            .min(1)
            .describe('Page UUID obtained from another Tool.'),
          fileName: z
            .string()
            .min(1)
            .max(255)
            .describe('File name including extension.'),
          contentBase64: z
            .string()
            .min(1)
            .max(14_000_000)
            .describe('Non-empty Base64 file content.'),
          attachmentId: z
            .string()
            .optional()
            .describe(
              'Existing attachment UUID to replace; omit to upload a new attachment.',
            ),
        },
      },
      (args) => this.runTool(() => this.uploadAttachment(ctx, args)),
    );
    this.toolRegistry.registerAll(server, ctx, (fn) => this.runTool(fn));

    return server;
  }

  private async getCitationPage(ctx: ToolContext, args: { pageUrl: string }) {
    const candidate = args.pageUrl.trim();
    const match = citationPageSegment.exec(candidate);
    const pageSlug = match?.[1] ?? candidate;
    const slugId = citationUuid.test(pageSlug)
      ? pageSlug
      : pageSlug.split('-').slice(-1)[0];
    if (
      !slugId ||
      (!citationUuid.test(slugId) && !citationSlugId.test(slugId))
    ) {
      throw new BadRequestException('Invalid Akasha shared Page URL');
    }
    const page = await this.pageRepo.findById(slugId, {
      includeContent: true,
    });
    if (
      !page ||
      page.workspaceId !== ctx.workspace.id ||
      page.deletedAt !== null
    ) {
      throw new NotFoundException('Shared Page not found');
    }
    await this.pageAccessService.validateCanReadCitationSourceWithPermissions(
      page,
      ctx.user,
    );
    return {
      pageId: page.id,
      spaceId: page.spaceId,
      title: getPageTitle(page.title),
      url: `/p/${page.slugId}`,
      content: page.content ? jsonToMarkdown(page.content) : '',
      updatedAt: page.updatedAt,
    };
  }

  private personalSpaceId(ctx: ToolContext): string {
    const spaceId = getApiKeyAccess(ctx.user)?.personalSpaceId;
    if (!spaceId) throw new ForbiddenException('Personal space is unavailable');
    return spaceId;
  }

  private async getAttachmentInfo(
    ctx: ToolContext,
    args: { attachmentId: string },
  ) {
    const attachment = await this.attachmentRepo.findById(args.attachmentId);
    if (
      !attachment ||
      !attachment.pageId ||
      attachment.workspaceId !== ctx.workspace.id
    ) {
      throw new NotFoundException('Attachment not found');
    }
    const page = await this.pageRepo.findById(attachment.pageId);
    if (!page) throw new NotFoundException('Attachment not found');
    await this.pageAccessService.validateCanView(page, ctx.user);
    const fileName = attachment.fileName ?? 'attachment';
    const url = `/api/files/${attachment.id}/${encodeURIComponent(fileName)}`;
    return {
      attachmentId: attachment.id,
      pageId: page.id,
      fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      url,
    };
  }

  private async downloadAttachment(
    ctx: ToolContext,
    args: { attachmentId: string },
  ) {
    const info = await this.getAttachmentInfo(ctx, args);
    return {
      ...info,
      downloadUrl: info.url,
    };
  }

  private async uploadAttachment(
    ctx: ToolContext,
    args: {
      pageId: string;
      fileName: string;
      contentBase64: string;
      attachmentId?: string;
    },
  ) {
    const page = await this.pageRepo.findById(args.pageId);
    if (!page || page.workspaceId !== ctx.workspace.id) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanEdit(page, ctx.user);

    let content: Buffer;
    try {
      content = Buffer.from(args.contentBase64, 'base64');
      if (
        !content.length ||
        content.toString('base64') !== args.contentBase64.replace(/\s/g, '')
      ) {
        throw new Error('invalid base64');
      }
    } catch {
      throw new BadRequestException(
        'contentBase64 must be valid non-empty Base64',
      );
    }

    const multipartFile = {
      filename: args.fileName,
      file: Readable.from(content),
      toBuffer: async () => content,
    } as any;
    const attachment = await this.attachmentService.uploadFile({
      filePromise: Promise.resolve(multipartFile),
      pageId: page.id,
      spaceId: page.spaceId,
      userId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      attachmentId: args.attachmentId,
    });
    const fileName = attachment.fileName;
    const url = `/api/files/${attachment.id}/${encodeURIComponent(fileName)}`;
    return {
      attachmentId: attachment.id,
      pageId: page.id,
      fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
      url,
      markdown: attachment.mimeType?.startsWith('image/')
        ? `![${fileName}](${url})`
        : `[${fileName}](${url})`,
      replaced: Boolean(args.attachmentId),
    };
  }

  private async deletePersonalPage(ctx: ToolContext, args: { pageId: string }) {
    const page = await this.pageRepo.findById(args.pageId);
    const personalSpaceId = this.personalSpaceId(ctx);
    if (
      !page ||
      page.workspaceId !== ctx.workspace.id ||
      page.spaceId !== personalSpaceId
    ) {
      throw new NotFoundException('Personal Page not found');
    }
    await this.pageAccessService.validateCanEdit(page, ctx.user);
    await this.pageService.removePage(page.id, ctx.user.id, ctx.workspace.id);
    return { success: true, pageId: page.id, deleted: true };
  }

  private async restorePersonalPage(
    ctx: ToolContext,
    args: { pageId: string },
  ) {
    const page = await this.pageRepo.findById(args.pageId);
    const personalSpaceId = this.personalSpaceId(ctx);
    if (
      !page ||
      page.workspaceId !== ctx.workspace.id ||
      page.spaceId !== personalSpaceId
    ) {
      throw new NotFoundException('Personal Page not found');
    }
    await this.requireSpaceAbility(
      ctx.user,
      page.spaceId,
      SpaceCaslAction.Edit,
      SpaceCaslSubject.Page,
    );
    await this.pageAccessService.validateCanEdit(page, ctx.user);
    await this.pageRepo.restorePage(page.id, ctx.workspace.id);
    return this.pageRepo.findById(page.id, { includeHasChildren: true });
  }

  private async listRecentPersonalPages(
    ctx: ToolContext,
    args: { limit?: number; cursor?: string; beforeCursor?: string },
  ) {
    return this.pageService.getRecentPages(ctx.user.id, this.pagination(args));
  }

  private async listTrashPersonalPages(
    ctx: ToolContext,
    args: { limit?: number; cursor?: string; beforeCursor?: string },
  ) {
    return this.pageService.getDeletedSpacePages(
      this.personalSpaceId(ctx),
      ctx.user.id,
      this.pagination(args),
    );
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
      spaceId?: string;
      title?: string;
      icon?: string;
      parentPageId?: string;
      content?: any;
      format?: ContentFormat;
    },
  ) {
    const spaceId = args.spaceId ?? this.personalSpaceId(ctx);
    if (args.parentPageId) {
      const parentPage = await this.pageRepo.findById(args.parentPageId);
      if (
        !parentPage ||
        parentPage.deletedAt ||
        parentPage.spaceId !== spaceId ||
        parentPage.workspaceId !== ctx.workspace.id
      ) {
        throw new NotFoundException('Parent page not found');
      }
      await this.pageAccessService.validateCanEdit(parentPage, ctx.user);
    } else {
      await this.requireSpaceAbility(
        ctx.user,
        spaceId,
        SpaceCaslAction.Create,
        SpaceCaslSubject.Page,
      );
    }

    const dto: CreatePageDto = {
      spaceId,
      title: args.title,
      icon: args.icon,
      parentPageId: args.parentPageId,
      content: args.content,
      format: this.contentFormatFor(args.content, args.format),
    };
    const page = await this.pageService.create(
      ctx.user.id,
      ctx.workspace.id,
      dto,
    );
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
      throw new BadRequestException(
        'operation is required when content is provided',
      );
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
    args: {
      spaceId: string;
      limit?: number;
      cursor?: string;
      beforeCursor?: string;
    },
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
    args: {
      pageId: string;
      limit?: number;
      cursor?: string;
      beforeCursor?: string;
    },
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

    return this.pageService.movePageToSpace(
      movedPage,
      args.spaceId,
      ctx.user.id,
    );
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

  private async getComments(
    ctx: ToolContext,
    args: {
      pageId: string;
      limit?: number;
      cursor?: string;
      beforeCursor?: string;
    },
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
    const accessibleIds = await this.pagePermissionRepo.filterAccessiblePageIds(
      {
        pageIds,
        userId: ctx.user.id,
        spaceId: args.spaceId,
      },
    );
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
          code:
            err?.code ??
            (err?.status === 404
              ? 'NOT_FOUND'
              : err?.status === 403
                ? 'FORBIDDEN'
                : err?.status === 400
                  ? 'INVALID_ARGUMENT'
                  : 'TOOL_FAILED'),
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
