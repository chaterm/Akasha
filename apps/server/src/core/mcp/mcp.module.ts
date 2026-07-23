import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpAuthService } from './mcp-auth.service';
import { ApiKeyRepo } from '@akasha/db/repos/api-key/api-key.repo';
import { TokenModule } from '../auth/token.module';
import { PageModule } from '../page/page.module';
import { SearchModule } from '../search/search.module';
import { SpaceModule } from '../space/space.module';
import { CommentModule } from '../comment/comment.module';
import { WorkspaceModule } from '../workspace/workspace.module';

@Module({
  imports: [
    TokenModule,
    PageModule,
    SearchModule,
    SpaceModule,
    CommentModule,
    WorkspaceModule,
  ],
  controllers: [McpController],
  providers: [McpService, McpAuthService, ApiKeyRepo],
})
export class McpModule {}
