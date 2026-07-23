import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import { TokenModule } from '../../core/auth/token.module';

/**
 * ApiKeyModule - API Key 管理模块
 *
 * 依赖说明：
 * - TokenModule: 提供 TokenService，用于生成 JWT API Token
 * - WorkspaceRepo / UserRepo: 来自 @Global() DatabaseModule，无需 import
 * - ApiKeyRepo: 不在全局 DatabaseModule 中，需本地声明为 provider
 */
@Module({
  imports: [TokenModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService, ApiKeyRepo],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
