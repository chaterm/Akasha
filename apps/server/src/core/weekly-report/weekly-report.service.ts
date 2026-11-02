import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { sql, Selectable } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../database/types/kysely.types';
import { dbOrTx } from '../../database/utils';
import { SpaceRepo } from '../../database/repos/space/space.repo';
import { PageRepo } from '../../database/repos/page/page.repo';
import { WeeklyReportRecords } from '../../database/types/weekly-report.types';
import { Page, Space } from '../../database/types/entity.types';
import { PageService } from '../page/services/page.service';
import { PageAccessService } from '../page/page-access/page-access.service';
import SpaceAbilityFactory from '../casl/abilities/space-ability.factory';
import {
  SpaceCaslAction,
  SpaceCaslSubject,
} from '../casl/interfaces/space-ability.type';
import { TemplateService } from '../template/template.service';
import { BUILTIN_WEEKLY_REPORT_ID } from '../template/builtin-templates';
import { resolveWeeklyReportDefaults } from './weekly-report-defaults';
import { isWeeklyReportDraft } from './weekly-report-draft';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { getApiKeyAccess } from '../../common/auth/api-key-access';
import { ApiKeyType } from '../../common/auth/api-key-type';
import type { McpToolContext } from '../mcp/mcp-tool-registry';
import { normalizeWeeklyReportContent } from './weekly-report-content';
import { resolveWeeklyReportPeriod } from './weekly-report-period';
import {
  PrepareWeeklyReportInput,
  SaveWeeklyReportInput,
  WeeklyReportClaims,
  WeeklyReportEffect,
  WeeklyReportResult,
} from './weekly-report.types';

type Target = { space: Space; parent: Page | null };
type Report = Selectable<WeeklyReportRecords>;
const TOKEN_TTL_SECONDS = 30 * 60;

@Injectable()
export class WeeklyReportService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly spaceRepo: SpaceRepo,
    private readonly pageRepo: PageRepo,
    private readonly pageService: PageService,
    private readonly pageAccess: PageAccessService,
    private readonly spaceAbility: SpaceAbilityFactory,
    private readonly templates: TemplateService,
    private readonly environment: EnvironmentService,
  ) {}

  private error(code: string, message: string, details?: unknown): never {
    throw new BadRequestException({
      code,
      message,
      ...(details ? { details } : {}),
    });
  }

  private personal(ctx: McpToolContext) {
    if (
      getApiKeyAccess(ctx.user)?.keyType !== ApiKeyType.PERSONAL ||
      ctx.agentAccess
    ) {
      this.error(
        'IDENTITY_UNSUPPORTED',
        'Weekly reports require a personal API key; SSO and Agent keys are not supported',
      );
    }
  }

  private async lock(trx: KyselyTransaction, key: string) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
      trx,
    );
  }

  private async target(
    ctx: McpToolContext,
    parentId?: string | null,
    trx?: KyselyTransaction,
  ): Promise<Target> {
    if (parentId) {
      const parent = await this.pageRepo.findById(parentId, {
        trx,
        withLock: !!trx,
      });
      if (
        !parent ||
        parent.deletedAt ||
        parent.workspaceId !== ctx.workspace.id
      )
        throw new NotFoundException('Parent page not found');
      const space = await this.spaceRepo.findById(
        parent.spaceId,
        ctx.workspace.id,
        { trx },
      );
      if (!space || space.deletedAt)
        throw new NotFoundException('Space not found');
      await this.pageAccess.validateCanView(parent, ctx.user);
      return { space, parent };
    }
    const space = await this.spaceRepo.findPersonalSpaceForUser({
      userId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      trx,
    });
    if (
      !space ||
      space.deletedAt ||
      space.workspaceId !== ctx.workspace.id ||
      space.personalOwnerId !== ctx.user.id
    ) {
      this.error(
        'PERSONAL_SPACE_UNAVAILABLE',
        'Initialize your Akasha personal space first',
      );
    }
    if (trx)
      await this.lock(
        trx,
        `weekly-directory:${ctx.workspace.id}:${ctx.user.id}`,
      );
    const matches = await dbOrTx(this.db, trx)
      .selectFrom('pages')
      .select('id')
      .where('workspaceId', '=', ctx.workspace.id)
      .where('spaceId', '=', space.id)
      .where('parentPageId', 'is', null)
      .where('deletedAt', 'is', null)
      .where('title', '=', '周报')
      .execute();
    const visible: Page[] = [];
    for (const row of matches) {
      const page = await this.pageRepo.findById(row.id, {
        trx,
        withLock: !!trx,
      });
      if (!page || page.deletedAt) continue;
      try {
        await this.pageAccess.validateCanView(page, ctx.user);
        visible.push(page);
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
      }
    }
    if (matches.length && !visible.length)
      throw new ForbiddenException(
        'The weekly report parent page is not writable',
      );
    if (visible.length > 1)
      this.error(
        'TARGET_AMBIGUOUS',
        'Choose one of the existing 周报 parent pages',
        {
          candidates: visible.map((page) => ({
            pageId: page.id,
            title: page.title,
            url: `/p/${page.slugId}`,
          })),
        },
      );
    return { space, parent: visible[0] ?? null };
  }

  private async writable(ctx: McpToolContext, target: Target) {
    if (target.parent) {
      await this.pageAccess.validateCanEdit(target.parent, ctx.user);
      if (target.parent.isLocked)
        this.error(
          'PARENT_LOCKED',
          'Unlock the parent page or choose another parent',
        );
    } else {
      const ability = await this.spaceAbility.createForUser(
        ctx.user,
        target.space.id,
      );
      if (ability.cannot(SpaceCaslAction.Create, SpaceCaslSubject.Page))
        throw new ForbiddenException();
    }
  }

  private findReport(
    ctx: McpToolContext,
    spaceId: string,
    parentId: string,
    start: string,
    end: string,
    trx?: KyselyTransaction,
  ) {
    return dbOrTx(this.db, trx)
      .selectFrom('weeklyReportRecords')
      .selectAll()
      .where('workspaceId', '=', ctx.workspace.id)
      .where('userId', '=', ctx.user.id)
      .where('spaceId', '=', spaceId)
      .where('parentPageId', '=', parentId)
      .where('periodStart', '=', start)
      .where('periodEnd', '=', end)
      .executeTakeFirst();
  }

  private formatResult(
    page: Page,
    report: Report,
    status: WeeklyReportResult['status'],
    parentCreated = false,
    contentPending = isWeeklyReportDraft(page.content as any),
  ): WeeklyReportResult {
    return {
      pageId: page.id,
      url: `/p/${page.slugId}`,
      title: page.title ?? '',
      spaceId: page.spaceId,
      parentPageId: page.parentPageId,
      parentCreated,
      templateId: report.templateId,
      periodStart: String(report.periodStart),
      periodEnd: String(report.periodEnd),
      timezone: report.timezone,
      status,
      replayed: status === 'replayed',
      locationChanged:
        page.parentPageId !== report.parentPageId ||
        page.spaceId !== report.spaceId,
      contentPending,
    };
  }

  private async existingResult(
    ctx: McpToolContext,
    report: Report,
    status: WeeklyReportResult['status'],
    parentCreated = false,
    trx?: KyselyTransaction,
  ) {
    const page = await this.pageRepo.findById(report.pageId, {
      trx,
      includeContent: true,
    });
    if (!page || page.deletedAt || page.workspaceId !== ctx.workspace.id)
      this.error(
        'RESULT_UNAVAILABLE',
        'The saved report is no longer available; it will not be recreated',
      );
    try {
      await this.pageAccess.validateCanView(page, ctx.user);
    } catch (error) {
      if (error instanceof ForbiddenException)
        this.error(
          'RESULT_UNAVAILABLE',
          'The saved report is not currently accessible',
        );
      throw error;
    }
    return this.formatResult(page, report, status, parentCreated);
  }

  async prepare(ctx: McpToolContext, input: PrepareWeeklyReportInput) {
    this.personal(ctx);
    input = resolveWeeklyReportDefaults(ctx, input);
    const period = resolveWeeklyReportPeriod(input);
    const target = await this.target(ctx, input.parentPageId);
    if (target.parent) {
      const existing = await this.findReport(
        ctx,
        target.space.id,
        target.parent.id,
        period.periodStart,
        period.periodEnd,
      );
      if (existing) return this.existingResult(ctx, existing, 'existing');
    }
    await this.writable(ctx, target);
    const template = await this.templates.getForSpace(
      input.templateId ?? BUILTIN_WEEKLY_REPORT_ID,
      target.space.id,
      ctx.user,
      ctx.workspace,
    );
    const claims: WeeklyReportClaims = {
      type: 'weekly_report_save',
      saveId: randomUUID(),
      userId: ctx.user.id,
      workspaceId: ctx.workspace.id,
      spaceId: target.space.id,
      parentPageId: target.parent?.id ?? null,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      timezone: period.timezone,
      templateId: template.id,
      templateFingerprint: template.templateFingerprint,
    };
    const saveToken = jwt.sign(claims, this.environment.getAppSecret(), {
      algorithm: 'HS256',
      expiresIn: TOKEN_TTL_SECONDS,
      issuer: 'Akasha',
      audience: 'weekly-report-save',
    });
    return {
      status: 'prepared' as const,
      user: { id: ctx.user.id, name: ctx.user.name },
      workspace: { id: ctx.workspace.id, name: ctx.workspace.name },
      ...period,
      title: `${period.periodStart} 至 ${period.periodEnd} 周报`,
      target: {
        spaceId: target.space.id,
        spaceName: target.space.name,
        parentPageId: target.parent?.id ?? null,
        parentTitle: target.parent?.title ?? '周报',
        willCreateParent: !target.parent,
      },
      template,
      saveToken,
      expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
  }

  private claims(ctx: McpToolContext, token: string): WeeklyReportClaims {
    try {
      const value = jwt.verify(token, this.environment.getAppSecret(), {
        algorithms: ['HS256'],
        issuer: 'Akasha',
        audience: 'weekly-report-save',
      }) as WeeklyReportClaims;
      if (
        value.type !== 'weekly_report_save' ||
        value.userId !== ctx.user.id ||
        value.workspaceId !== ctx.workspace.id ||
        !value.saveId
      ) {
        this.error(
          'INVALID_SAVE_TOKEN',
          'Save token does not match this user or workspace',
        );
      }
      return value;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.error(
        error instanceof jwt.TokenExpiredError
          ? 'SAVE_TOKEN_EXPIRED'
          : 'INVALID_SAVE_TOKEN',
        'Prepare the weekly report again to obtain a valid save token',
      );
    }
  }

  private async receipt(
    trx: KyselyTransaction,
    claims: WeeklyReportClaims,
    reportId: string,
    parentCreated: boolean,
  ) {
    await trx
      .insertInto('weeklyReportSaveReceipts')
      .values({
        saveId: claims.saveId,
        workspaceId: claims.workspaceId,
        userId: claims.userId,
        reportRecordId: reportId,
        parentCreated,
      })
      .execute();
  }

  private async effects(
    trx: KyselyTransaction,
    ctx: McpToolContext,
    pageId: string,
    compile: boolean,
  ) {
    const effects: WeeklyReportEffect[] = [
      'search',
      'access',
      'watchers',
      'audit',
      ...(compile ? ['compile' as const] : []),
    ];
    await trx
      .insertInto('weeklyReportOutbox')
      .values(
        effects.map((effect) => ({
          id: randomUUID(),
          pageId,
          workspaceId: ctx.workspace.id,
          userId: ctx.user.id,
          effect,
          deliveredAt: null,
        })),
      )
      .execute();
  }

  async save(
    ctx: McpToolContext,
    input: SaveWeeklyReportInput,
  ): Promise<WeeklyReportResult> {
    this.personal(ctx);
    const claims = this.claims(ctx, input.saveToken);
    try {
      return await this.saveAttempt(ctx, input, claims);
    } catch (error) {
      // Advisory locks serialize our writers. Keep a database-constraint safety
      // net for a competing writer that does not participate in those locks.
      // A PostgreSQL uniqueness failure aborts its transaction: retry outside it.
      const constraint =
        (error as any)?.constraint_name ?? (error as any)?.constraint;
      if (
        (error as any)?.code === '23505' &&
        [
          'weekly_report_business_key',
          'weekly_report_save_receipts_pkey',
        ].includes(constraint)
      ) {
        return this.saveAttempt(ctx, input, claims);
      }
      throw error;
    }
  }

  private saveAttempt(
    ctx: McpToolContext,
    input: SaveWeeklyReportInput,
    claims: WeeklyReportClaims,
  ): Promise<WeeklyReportResult> {
    return this.db.transaction().execute(async (trx) => {
      await this.lock(
        trx,
        `weekly-save:${ctx.workspace.id}:${ctx.user.id}:${claims.saveId}`,
      );
      const receipt = await trx
        .selectFrom('weeklyReportSaveReceipts')
        .selectAll()
        .where('workspaceId', '=', ctx.workspace.id)
        .where('userId', '=', ctx.user.id)
        .where('saveId', '=', claims.saveId)
        .executeTakeFirst();
      if (receipt) {
        const report = await trx
          .selectFrom('weeklyReportRecords')
          .selectAll()
          .where('id', '=', receipt.reportRecordId)
          .executeTakeFirstOrThrow();
        return this.existingResult(
          ctx,
          report,
          'replayed',
          receipt.parentCreated,
          trx,
        );
      }
      const target = await this.target(ctx, claims.parentPageId, trx);
      if (target.space.id !== claims.spaceId)
        this.error(
          'INVALID_SAVE_TOKEN',
          'The target parent changed space; prepare again',
        );
      const reuse = async (parent: Page) => {
        const report = await this.findReport(
          ctx,
          target.space.id,
          parent.id,
          claims.periodStart,
          claims.periodEnd,
          trx,
        );
        if (!report) return null;
        const result = await this.existingResult(
          ctx,
          report,
          'existing',
          false,
          trx,
        );
        await this.receipt(trx, claims, report.id, false);
        return result;
      };
      if (target.parent) {
        const existing = await reuse(target.parent);
        if (existing) return existing;
      }
      await this.writable(ctx, target);
      const template = await this.templates.getForSpace(
        claims.templateId,
        target.space.id,
        ctx.user,
        ctx.workspace,
      );
      const content = normalizeWeeklyReportContent(input.content);
      const title =
        input.title?.trim() ||
        `${claims.periodStart} 至 ${claims.periodEnd} 周报`;
      if (title.length > 200)
        this.error(
          'INVALID_ARGUMENT',
          'Report title must not exceed 200 characters',
        );
      let parentCreated = false;
      if (!target.parent) {
        target.parent = await this.pageService.create(
          ctx.user.id,
          ctx.workspace.id,
          {
            spaceId: target.space.id,
            title: '周报',
            icon: '📅',
            format: 'json',
            content: { type: 'doc', content: [{ type: 'paragraph' }] },
          },
          { trx, deferCreatedEffects: true },
        );
        parentCreated = true;
        await this.effects(trx, ctx, target.parent.id, false);
      }
      await this.lock(
        trx,
        `weekly-business:${ctx.workspace.id}:${ctx.user.id}:${target.space.id}:${target.parent.id}:${claims.periodStart}:${claims.periodEnd}`,
      );
      const existing = await reuse(target.parent);
      if (existing) return existing;
      const page = await this.pageService.create(
        ctx.user.id,
        ctx.workspace.id,
        {
          spaceId: target.space.id,
          parentPageId: target.parent.id,
          title,
          icon: template.icon ?? undefined,
          format: 'json',
          content,
        },
        { trx, deferCreatedEffects: true },
      );
      const report = await trx
        .insertInto('weeklyReportRecords')
        .values({
          id: randomUUID(),
          workspaceId: ctx.workspace.id,
          userId: ctx.user.id,
          spaceId: target.space.id,
          parentPageId: target.parent.id,
          pageId: page.id,
          periodStart: claims.periodStart,
          periodEnd: claims.periodEnd,
          timezone: claims.timezone,
          templateId: claims.templateId,
          templateFingerprint: claims.templateFingerprint,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.receipt(trx, claims, report.id, parentCreated);
      const contentPending = isWeeklyReportDraft(content);
      await this.effects(trx, ctx, page.id, !contentPending);
      return this.formatResult(
        page,
        report,
        'created',
        parentCreated,
        contentPending,
      );
    });
  }
}
