import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@akasha/db/types/entity.types';
import WorkspaceAbilityFactory from '../casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../casl/interfaces/workspace-ability.type';
import { AnalyticsService } from './analytics.service';
import { AnalyticsUsageService } from './analytics-usage.service';
import {
  AnalyticsOverviewQueryDto,
  TrackPageViewDto,
  AnalyticsUsageQueryDto,
} from './dto/analytics.dto';

@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
    private readonly usageService: AnalyticsUsageService,
  ) {}

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('track')
  async track(
    @Body() dto: TrackPageViewDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    await this.analyticsService.trackPageView(dto, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Get('overview')
  async overview(
    @Query() query: AnalyticsOverviewQueryDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }

    return this.analyticsService.getOverview({
      workspace,
      range: query.range ?? '30d',
      spaceId: query.spaceId,
      from: query.from,
      to: query.to,
    });
  }

  @Get('usage')
  async usage(
    @Query() query: AnalyticsUsageQueryDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanRead(user, workspace);
    return this.usageService.query(workspace.id, query);
  }

  @Get('usage/events')
  async events(
    @Query() query: AnalyticsUsageQueryDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertCanRead(user, workspace);
    return this.usageService.query(workspace.id, query, true);
  }

  private assertCanRead(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }
}
