import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import {
  TemplateRepo,
  TemplateRow,
  TemplateSpaceFilter,
} from '@akasha/db/repos/template/template.repo';
import { PageRepo } from '@akasha/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { KyselyDB } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
import { Page, User, Workspace } from '@akasha/db/types/entity.types';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { PageAccessService } from '../page/page-access/page-access.service';
import { PageService } from '../page/services/page.service';
import { isWorkspaceAdmin } from '../../common/helpers/types/permission';
import { jsonToNode, jsonToText } from '../../collaboration/collaboration.util';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  CreateTemplateDto,
  ListTemplatesDto,
  UpdateTemplateDto,
  UseTemplateDto,
} from './dto/template.dto';
import { buildOutline, OutlineItem } from './template-outline';
import {
  BUILTIN_TEMPLATE_DATE,
  BUILTIN_TEMPLATES,
  BuiltinTemplate,
  findBuiltinTemplate,
} from './builtin-templates';

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

/** 带 builtin 标记的模板行；内置模板不在数据库里。 */
type ResolvedTemplate = TemplateRow & {
  builtin?: boolean;
  /** 内置模板的建页标题格式，仅代码内置模板有值。 */
  pageTitlePattern?: string;
};

/**
 * 对外返回的模板：
 * - spaceIds 只包含当前用户能访问的空间；
 * - otherSpaceCount 为用户看不到的已指定空间数（只用于展示"另有 N 个空间"）；
 * - builtin 为 true 时是代码内置的公共模板，只读。
 */
export type TemplateView = Omit<TemplateRow, 'spaceIds'> & {
  spaceIds: string[];
  otherSpaceCount: number;
  canManage: boolean;
  builtin: boolean;
};
export type TemplateListItem = Omit<TemplateView, 'content'> & {
  outline: OutlineItem[];
};

interface Availability {
  allSpaces: boolean;
  spaceIds: string[];
}

@Injectable()
export class TemplateService {
  constructor(
    private readonly templateRepo: TemplateRepo,
    private readonly pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly pageAccessService: PageAccessService,
    private readonly pageService: PageService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async list(user: User, workspace: Workspace, dto: ListTemplatesDto) {
    const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(user.id);
    const scope = dto.scope ?? 'all';

    const filter: TemplateSpaceFilter =
      scope === 'allSpaces'
        ? { mode: 'allSpaces' }
        : scope === 'space'
          ? { mode: 'assignedTo', spaceId: dto.spaceId }
          : scope === 'available'
            ? { mode: 'availableIn', spaceId: dto.spaceId }
            : { mode: 'accessible' };

    const result = await this.templateRepo.findTemplates(
      workspace.id,
      userSpaceIds,
      dto,
      filter,
      {
        includeContent: true,
        isAdmin: isWorkspaceAdmin(user.role),
        userId: user.id,
      },
    );

    // 内置模板对所有空间可用：只在首页、且不是"指定到某空间"的筛选时追加在最前
    const builtins =
      scope === 'space' || dto.cursor || dto.beforeCursor
        ? []
        : this.matchBuiltins(dto.query).map((tpl) =>
            this.builtinRow(tpl, workspace),
          );

    return {
      ...result,
      items: [...builtins, ...(result.items as TemplateRow[])].map(
        (row): TemplateListItem => {
          const { content, ...view } = this.toView(
            row,
            user,
            workspace,
            userSpaceIds,
          );
          return { ...view, outline: buildOutline(content) };
        },
      ),
    };
  }

  async getById(
    templateId: string,
    user: User,
    workspace: Workspace,
  ): Promise<TemplateView> {
    const { template, userSpaceIds } = await this.findVisibleOrThrow(
      templateId,
      user,
      workspace,
      { includeContent: true },
    );
    return this.toView(template, user, workspace, userSpaceIds);
  }

  async create(
    dto: CreateTemplateDto,
    user: User,
    workspace: Workspace,
  ): Promise<TemplateView> {
    if (dto.content && dto.sourcePageId) {
      throw new BadRequestException(
        'content and sourcePageId are mutually exclusive',
      );
    }

    // 未指定范围时默认"所有空间"
    const availability = this.normalizeAvailability(
      dto.allSpaces === undefined && dto.spaceIds === undefined
        ? { allSpaces: true }
        : dto,
    );
    await this.assertCanAssign(availability, [], user, workspace);

    let content: any = dto.content ?? EMPTY_DOC;
    if (dto.sourcePageId) {
      content = await this.readSourcePageContent(dto.sourcePageId, user, workspace);
    }
    const textContent = this.toText(content);

    const id = await executeTx(this.db, async (trx) => {
      const { id } = await this.templateRepo.insertTemplate(
        {
          title: dto.title,
          description: dto.description ?? null,
          icon: dto.icon ?? null,
          allSpaces: availability.allSpaces,
          content,
          textContent,
          workspaceId: workspace.id,
          creatorId: user.id,
          lastUpdatedById: user.id,
        },
        trx,
      );
      await this.templateRepo.setTemplateSpaces(id, availability.spaceIds, trx);
      return id;
    });

    this.auditService.log({
      event: AuditEvent.TEMPLATE_CREATED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: id,
      changes: { after: { title: dto.title, ...availability } },
      metadata: dto.sourcePageId ? { sourcePageId: dto.sourcePageId } : undefined,
    });

    return this.getById(id, user, workspace);
  }

  async update(
    dto: UpdateTemplateDto,
    user: User,
    workspace: Workspace,
  ): Promise<TemplateView> {
    const { template, userSpaceIds } = await this.findVisibleOrThrow(
      dto.templateId,
      user,
      workspace,
    );
    this.assertCanManage(template, user, workspace);

    let nextAvailability: Availability | null = null;
    if (dto.allSpaces !== undefined || dto.spaceIds !== undefined) {
      const requested = this.normalizeAvailability({
        allSpaces: dto.allSpaces ?? template.allSpaces,
        spaceIds: dto.spaceIds ?? template.spaceIds,
      });
      // 用户看不到的已指定空间原样保留，避免一次保存把别人加的空间删掉
      const hidden = template.spaceIds.filter((id) => !userSpaceIds.includes(id));
      nextAvailability = requested.allSpaces
        ? requested
        : {
            allSpaces: false,
            spaceIds: [...new Set([...requested.spaceIds, ...hidden])],
          };
      await this.assertCanAssign(
        nextAvailability,
        template.allSpaces ? null : template.spaceIds,
        user,
        workspace,
      );
    }

    const patch: Record<string, any> = { lastUpdatedById: user.id };
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.icon !== undefined) patch.icon = dto.icon;
    if (nextAvailability) patch.allSpaces = nextAvailability.allSpaces;
    if (dto.content !== undefined) {
      patch.content = dto.content;
      patch.textContent = this.toText(dto.content);
    }

    await executeTx(this.db, async (trx) => {
      await this.templateRepo.updateTemplate(patch, template.id, workspace.id, trx);
      if (nextAvailability) {
        await this.templateRepo.setTemplateSpaces(
          template.id,
          nextAvailability.allSpaces ? [] : nextAvailability.spaceIds,
          trx,
        );
      }
    });

    const availabilityChanged =
      nextAvailability &&
      (nextAvailability.allSpaces !== template.allSpaces ||
        !sameSet(nextAvailability.spaceIds, template.spaceIds));
    this.auditService.log({
      event: AuditEvent.TEMPLATE_UPDATED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: template.id,
      changes: availabilityChanged
        ? {
            before: { allSpaces: template.allSpaces, spaceIds: template.spaceIds },
            after: nextAvailability,
          }
        : undefined,
    });

    return this.getById(template.id, user, workspace);
  }

  async delete(templateId: string, user: User, workspace: Workspace) {
    const { template } = await this.findVisibleOrThrow(templateId, user, workspace);
    this.assertCanManage(template, user, workspace);

    await this.templateRepo.deleteTemplate(template.id, workspace.id);

    this.auditService.log({
      event: AuditEvent.TEMPLATE_DELETED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: template.id,
      changes: { before: { title: template.title } },
    });
  }

  async use(dto: UseTemplateDto, user: User, workspace: Workspace) {
    const { template } = await this.findVisibleOrThrow(
      dto.templateId,
      user,
      workspace,
      { includeContent: true },
    );

    if (!template.allSpaces && !template.spaceIds.includes(dto.spaceId)) {
      throw new BadRequestException('Template is not available in this space');
    }

    if (dto.parentPageId) {
      const parent = await this.pageRepo.findById(dto.parentPageId);
      if (
        !parent ||
        parent.deletedAt ||
        parent.workspaceId !== workspace.id ||
        parent.spaceId !== dto.spaceId
      ) {
        throw new NotFoundException('Parent page not found');
      }
      await this.pageAccessService.validateCanEdit(parent, user);
    } else {
      await this.assertCanCreatePage(dto.spaceId, user);
    }

    const page = await this.pageService.create(user.id, workspace.id, {
      spaceId: dto.spaceId,
      parentPageId: dto.parentPageId,
      title: this.resolvePageTitle(template, user),
      icon: template.icon ?? undefined,
      content: (template.content as object) ?? EMPTY_DOC,
      format: 'json',
    });

    this.auditService.log({
      event: AuditEvent.PAGE_CREATED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      changes: { after: { title: page.title, spaceId: page.spaceId } },
      metadata: { templateId: template.id },
    });

    return page;
  }

  private async findVisibleOrThrow(
    templateId: string,
    user: User,
    workspace: Workspace,
    opts?: { includeContent?: boolean },
  ): Promise<{ template: ResolvedTemplate; userSpaceIds: string[] }> {
    const builtin = findBuiltinTemplate(templateId);
    if (builtin) {
      const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(user.id);
      return { template: this.builtinRow(builtin, workspace), userSpaceIds };
    }

    const template = await this.templateRepo.findById(templateId, workspace.id, {
      includeContent: opts?.includeContent,
    });
    if (!template || template.deletedAt) {
      throw new NotFoundException('Template not found');
    }
    const userSpaceIds = await this.spaceMemberRepo.getUserSpaceIds(user.id);
    const visible =
      isWorkspaceAdmin(user.role) ||
      template.creatorId === user.id ||
      template.allSpaces ||
      template.spaceIds.some((id) => userSpaceIds.includes(id));
    // 不可见与不存在返回同一错误，避免泄露模板存在性
    if (!visible) throw new NotFoundException('Template not found');
    return { template, userSpaceIds };
  }

  private normalizeAvailability(input: {
    allSpaces?: boolean;
    spaceIds?: string[];
  }): Availability {
    if (input.allSpaces) return { allSpaces: true, spaceIds: [] };
    const spaceIds = [...new Set(input.spaceIds ?? [])];
    if (spaceIds.length === 0) {
      throw new BadRequestException(
        'Choose at least one space, or make the template available in all spaces',
      );
    }
    return { allSpaces: false, spaceIds };
  }

  private canManage(template: ResolvedTemplate, user: User, workspace: Workspace) {
    // 内置模板只读，管理员也不能改删
    if (template.builtin) return false;
    if (isWorkspaceAdmin(user.role)) return true;
    // 普通用户可以管理自己创建的模板
    return template.creatorId === user.id;
  }

  private assertCanManage(template: ResolvedTemplate, user: User, workspace: Workspace) {
    if (!this.canManage(template, user, workspace)) {
      throw new ForbiddenException();
    }
  }

  /**
   * 校验能否设置该可用范围。
   * @param currentSpaceIds 已指定的空间；新增的空间才需要建页权限。null 表示原来是"所有空间"。
   */
  private async assertCanAssign(
    next: Availability,
    currentSpaceIds: string[] | null,
    user: User,
    workspace: Workspace,
  ) {
    if (next.allSpaces) return;
    const added = next.spaceIds.filter((id) => !currentSpaceIds?.includes(id));
    for (const spaceId of added) {
      await this.assertCanCreatePage(spaceId, user);
    }
  }

  private async assertCanCreatePage(spaceId: string, user: User) {
    const ability = await this.spaceAbility.createForUser(user, spaceId);
    if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page)) {
      throw new ForbiddenException();
    }
  }

  private async readSourcePageContent(
    pageId: string,
    user: User,
    workspace: Workspace,
  ) {
    const page: Page = await this.pageRepo.findById(pageId, {
      includeContent: true,
    });
    if (!page || page.deletedAt || page.workspaceId !== workspace.id) {
      throw new NotFoundException('Page not found');
    }
    await this.pageAccessService.validateCanView(page, user);
    return page.content ?? EMPTY_DOC;
  }

  private toText(content: any): string {
    try {
      jsonToNode(content);
      return jsonToText(content);
    } catch {
      throw new BadRequestException('Invalid content format');
    }
  }

  /** 内置模板可以用日期命名页面标题；普通模板沿用模板标题。 */
  private resolvePageTitle(
    template: ResolvedTemplate,
    user: User,
  ): string | undefined {
    if (!template.pageTitlePattern) return template.title ?? undefined;
    return template.pageTitlePattern
      .replace('{date}', localDate(user.timezone))
      .replace('{title}', template.title ?? '');
  }

  private toView(
    template: ResolvedTemplate,
    user: User,
    workspace: Workspace,
    userSpaceIds: string[],
  ): TemplateView {
    const spaceIds = template.spaceIds ?? [];
    const visibleSpaceIds = spaceIds.filter((id) => userSpaceIds.includes(id));
    return {
      ...template,
      spaceIds: visibleSpaceIds,
      otherSpaceCount: spaceIds.length - visibleSpaceIds.length,
      canManage: this.canManage(template, user, workspace),
      builtin: template.builtin === true,
    };
  }

  private matchBuiltins(query?: string): BuiltinTemplate[] {
    const q = query?.trim().toLowerCase();
    if (!q) return BUILTIN_TEMPLATES;
    return BUILTIN_TEMPLATES.filter(
      (tpl) =>
        tpl.title.toLowerCase().includes(q) ||
        tpl.description.toLowerCase().includes(q),
    );
  }

  /** 把内置模板转成与数据库行同形的结构。 */
  private builtinRow(
    tpl: BuiltinTemplate,
    workspace: Workspace,
  ): ResolvedTemplate {
    return {
      id: tpl.id,
      title: tpl.title,
      description: tpl.description,
      icon: tpl.icon,
      allSpaces: true,
      spaceIds: [],
      // 复制一份，避免调用方改动共享的模块级对象
      content: structuredClone(tpl.content),
      workspaceId: workspace.id,
      creatorId: null,
      lastUpdatedById: null,
      createdAt: BUILTIN_TEMPLATE_DATE,
      updatedAt: BUILTIN_TEMPLATE_DATE,
      deletedAt: null,
      builtin: true,
      pageTitlePattern: tpl.pageTitlePattern,
    } as ResolvedTemplate;
  }
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** 按用户时区取当天日期（YYYY/MM/DD）；时区缺失或非法时退回服务器时区。 */
function localDate(timeZone: string | null | undefined): string {
  const now = new Date();
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  try {
    if (timeZone) options.timeZone = timeZone;
    const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(now);
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}/${get('month')}/${get('day')}`;
  } catch {
    const iso = now.toISOString().slice(0, 10);
    return iso.replace(/-/g, '/');
  }
}
