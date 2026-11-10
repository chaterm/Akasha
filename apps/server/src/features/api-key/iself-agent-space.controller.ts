import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User, Workspace } from '@akasha/db/types/entity.types';
import type { AgentAccessContext } from '../../common/auth/agent-access-context';
import { AuthCredentialPolicy } from '../../common/auth/auth-credential-policy';
import { AgentAccess } from '../../common/decorators/agent-access.decorator';
import { AuthCredentials } from '../../common/decorators/auth-credentials.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AgentSpaceBindingService } from './agent-space-binding.service';
import { UpdateAgentSpaceBindingsDto } from './dto/update-agent-space-bindings.dto';

@Controller('iself')
@UseGuards(JwtAuthGuard)
export class IselfAgentSpaceController {
  constructor(
    private readonly agentSpaceBindingService: AgentSpaceBindingService,
  ) {}

  @Post('space')
  @HttpCode(HttpStatus.OK)
  @AuthCredentials(AuthCredentialPolicy.SSO_OR_AGENT)
  async getSpaces(
    @AuthUser() principal: User,
    @AuthWorkspace() workspace: Workspace,
    @AgentAccess() agentAccess?: AgentAccessContext,
  ) {
    return this.agentSpaceBindingService.getSpaces({
      workspace,
      user: agentAccess ? agentAccess.delegatedUser : principal,
      agentAccess,
    });
  }

  @Post('space-api-key/update')
  @HttpCode(HttpStatus.OK)
  @AuthCredentials(AuthCredentialPolicy.AGENT_AND_SSO)
  async replaceBindings(
    @Body() dto: UpdateAgentSpaceBindingsDto,
    @AuthWorkspace() workspace: Workspace,
    @AgentAccess() agentAccess: AgentAccessContext,
  ) {
    return this.agentSpaceBindingService.replaceBindings({
      workspace,
      agentAccess,
      spaceIds: dto.spaceIds,
    });
  }
}
