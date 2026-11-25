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
import { UserIdentityRequired } from '../../common/decorators/user-identity-required.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AgentCallable } from '../../common/decorators/agent-callable.decorator';
import { AgentCapability } from '../../common/auth/agent-capability';
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
  @AgentCallable(AgentCapability.SPACE_READ)
  async getSpaces(
    @AuthUser() principal: User,
    @AuthWorkspace() workspace: Workspace,
    @AgentAccess() agentAccess?: AgentAccessContext,
  ) {
    return this.agentSpaceBindingService.getSpaces({
      workspace,
      user: principal,
      agentAccess,
    });
  }

  @Post('space-api-key/update')
  @HttpCode(HttpStatus.OK)
  @AgentCallable(AgentCapability.SPACE_BINDING_UPDATE)
  @AuthCredentials(AuthCredentialPolicy.AGENT_SCOPE_REQUIRED)
  @UserIdentityRequired()
  async replaceBindings(
    @Body() dto: UpdateAgentSpaceBindingsDto,
    @AuthUser() principal: User,
    @AuthWorkspace() workspace: Workspace,
    @AgentAccess() agentAccess: AgentAccessContext,
  ) {
    return this.agentSpaceBindingService.replaceBindings({
      workspace,
      user: principal,
      agentAccess,
      spaceIds: dto.spaceIds,
    });
  }
}
