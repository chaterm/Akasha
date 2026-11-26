import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { User, Workspace } from '@akasha/db/types/entity.types';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { QueryKnowledgeDto } from './dto/query-knowledge.dto';
import { KnowledgeQueryService } from './services/knowledge-query.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AgentCallable } from '../../common/decorators/agent-callable.decorator';
import { AgentCapability } from '../../common/auth/agent-capability';
import { AuthCredentials } from '../../common/decorators/auth-credentials.decorator';
import { AuthCredentialPolicy } from '../../common/auth/auth-credential-policy';
import { AgentAccess } from '../../common/decorators/agent-access.decorator';
import type { AgentAccessContext } from '../../common/auth/agent-access-context';

@UseGuards(JwtAuthGuard)
@Controller('iself/llm-wiki')
export class IsElfLlmWikiController {
  private readonly logger = new Logger(IsElfLlmWikiController.name);

  constructor(private readonly queries: KnowledgeQueryService) {}

  @HttpCode(HttpStatus.OK)
  @Post('query')
  @AgentCallable(AgentCapability.KNOWLEDGE_QUERY)
  @AuthCredentials(AuthCredentialPolicy.AGENT_SCOPE_REQUIRED)
  async queryKnowledge(
    @Body() dto: QueryKnowledgeDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @AgentAccess() agentAccess: AgentAccessContext,
  ) {
    this.logger.log(
      `iself knowledge query: workspace=${workspace.id} user=${user.id} ` +
        `query=${JSON.stringify(dto.query)} body=${JSON.stringify(dto)}`,
    );

    return this.queries.query(
      dto,
      user,
      workspace,
      agentAccess,
      'iself_knowledge_query',
    );
  }
}
