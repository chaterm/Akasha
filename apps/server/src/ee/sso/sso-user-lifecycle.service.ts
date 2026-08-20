import { Injectable, NotFoundException } from '@nestjs/common';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { WorkspaceService } from '../../core/workspace/services/workspace.service';
import { DeleteUserDto } from './dto/sso-arch.dto';

@Injectable()
export class SsoUserLifecycleService {
  constructor(
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly userRepo: UserRepo,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async DeleteUser(dto: DeleteUserDto): Promise<void> {
    const workspace = await this.workspaceRepo.findFirst();
    if (!workspace) throw new NotFoundException('Workspace not initialized');

    const user = await this.userRepo.findByEmail(dto.email, workspace.id);
    if (!user || user.deletedAt) return;

    await this.workspaceService.deleteUserBySso(user.id, workspace.id);
  }
}
