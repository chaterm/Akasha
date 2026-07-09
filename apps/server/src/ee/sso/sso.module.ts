import { Module } from '@nestjs/common';
import { HoidcController } from './hoidc.controller';
import { HoidcService } from './hoidc.service';
import { UserModule } from '../../core/user/user.module';
import { SpaceModule } from '../../core/space/space.module';
import { WorkspaceModule } from '../../core/workspace/workspace.module';

/**
 * SSO Module - 处理 HOIDC 单点登录
 *
 * 依赖说明：
 * - SessionService 来自 @Global() SessionModule，无需 import
 * - EnvironmentService 来自 @Global() EnvironmentModule，无需 import
 * - DatabaseModule 是 @Global()，KyselyDB 注入无需 import
 * - UserRepo 在 UserModule 中 export，需要显式 import
 * - GroupUserRepo 在 DatabaseModule(@Global) 中 export，无需 import
 */
@Module({
  imports: [UserModule, SpaceModule, WorkspaceModule],
  controllers: [HoidcController],
  providers: [HoidcService],
  exports: [HoidcService],
})
export class SsoModule {}
