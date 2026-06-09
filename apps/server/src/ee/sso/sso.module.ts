import { Module } from '@nestjs/common';
import { HoidcController } from './hoidc.controller';
import { HoidcService } from './hoidc.service';
import { UserModule } from '../../core/user/user.module';

/**
 * SSO Module - 处理 HOIDC 单点登录
 *
 * 依赖说明：
 * - SessionService 来自 @Global() SessionModule，无需 import
 * - EnvironmentService 来自 @Global() EnvironmentModule，无需 import
 * - DatabaseModule 是 @Global()，KyselyDB 注入无需 import
 * - UserRepo 在 UserModule 中 export，需要显式 import
 */
@Module({
  imports: [UserModule],
  controllers: [HoidcController],
  providers: [HoidcService],
})
export class SsoModule {}
