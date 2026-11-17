import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import { TokenModule } from '../../core/auth/token.module';
import { AgentUserService } from './agent-user.service';
import { AgentSpaceBindingService } from './agent-space-binding.service';
import { IselfAgentSpaceController } from './iself-agent-space.controller';
import { IselfApiKeyController } from './iself-api-key.controller';
import { IselfPlatformAuthGuard } from './guards/iself-platform-auth.guard';

@Module({
  imports: [TokenModule],
  controllers: [
    ApiKeyController,
    IselfAgentSpaceController,
    IselfApiKeyController,
  ],
  providers: [
    ApiKeyService,
    ApiKeyRepo,
    AgentUserService,
    AgentSpaceBindingService,
    IselfPlatformAuthGuard,
  ],
  exports: [ApiKeyService, AgentUserService, AgentSpaceBindingService],
})
export class ApiKeyModule {}
