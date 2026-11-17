import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Workspace } from '@akasha/db/types/entity.types';
import { ApiKeyService } from './api-key.service';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { IselfPlatformAuthGuard } from './guards/iself-platform-auth.guard';
import { CreateIselfAgentApiKeyDto } from './dto/create-iself-agent-api-key.dto';

@Controller('iself/api-keys')
@UseGuards(IselfPlatformAuthGuard)
export class IselfApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post('public/create')
  @HttpCode(HttpStatus.OK)
  async createAgentApiKey(
    @Body() dto: CreateIselfAgentApiKeyDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.apiKeyService.createAgentApiKeyForPlatform({
      agentId: dto.agent_id,
      name: dto.agent_name,
      workspaceId: workspace.id,
    });
  }
}
