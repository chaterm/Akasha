import { Controller, Get, Query, Req } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { LegacyLinkService } from './legacy-link.service';
import { FastifyRequest } from 'fastify';

@Controller('legacy-links/confluence')
export class LegacyLinkController {
  constructor(private readonly legacyLinkService: LegacyLinkService) {}

  @Public()
  @Get('resolve')
  async resolve(
    @Query('path') path: string,
    @Query('pageId') pageId: string,
    @Query('spaceKey') spaceKey: string,
    @Query('title') title: string,
    @Query('anchor') anchor: string,
    @Query('workspaceId') workspaceId: string,
    @Req() req: FastifyRequest,
  ) {
    return this.legacyLinkService.resolve({
      workspaceId: workspaceId || req.raw?.['workspace']?.id,
      source: 'confluence',
      path,
      pageId,
      spaceKey,
      title,
      anchor,
    });
  }
}
