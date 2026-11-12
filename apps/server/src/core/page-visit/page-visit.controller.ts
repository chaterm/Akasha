import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { PageVisitService } from './page-visit.service';
import { RecentPageVisitsDto, RecordPageVisitDto } from './dto/page-visit.dto';

@UseGuards(JwtAuthGuard)
@Controller('page-visits')
export class PageVisitController {
  constructor(private readonly pageVisitService: PageVisitService) {}

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post()
  async record(
    @Body() dto: RecordPageVisitDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ): Promise<void> {
    await this.pageVisitService.record(dto.pageId, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('recent')
  async findRecent(
    @Body() dto: RecentPageVisitsDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.pageVisitService.findRecent({
      user,
      workspace,
      spaceId: dto.spaceId,
      cursor: dto.cursor,
      limit: dto.limit,
    });
  }
}
