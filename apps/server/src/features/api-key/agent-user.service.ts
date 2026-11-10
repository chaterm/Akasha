import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UserRepo } from '@akasha/db/repos/user/user.repo';
import { KyselyTransaction } from '@akasha/db/types/kysely.types';
import { User } from '@akasha/db/types/entity.types';
import { UserRole } from '../../common/helpers/types/permission';
import { UserType } from '../../common/auth/user-type';

@Injectable()
export class AgentUserService {
  constructor(private readonly userRepo: UserRepo) {}

  /**
   * Creates an agent (digital-employee) user. When `agentId` is supplied (e.g.
   * by an external platform), it is used as the stable identifier segment of
   * the email so the same caller-side agent maps to a deterministic address;
   * otherwise a random UUID is generated. A duplicate `agentId` collides on the
   * email unique constraint and surfaces as a conflict upstream.
   */
  async create(
    name: string,
    workspaceId: string,
    trx: KyselyTransaction,
    agentId?: string,
  ): Promise<User> {
    return this.userRepo.insertAgentUser(
      {
        email: `agent-user-${agentId ?? randomUUID()}@akasha.net`,
        name,
        workspaceId,
        role: UserRole.MEMBER,
      },
      trx,
    );
  }

  async requireActive(
    userId: string,
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<User> {
    const user = await this.userRepo.findById(userId, workspaceId, { trx });
    if (
      !user ||
      user.userType !== UserType.AGENT ||
      user.deletedAt ||
      user.deactivatedAt
    ) {
      throw new NotFoundException('Agent user not found');
    }
    return user;
  }

  async rename(
    userId: string,
    workspaceId: string,
    name: string,
    trx: KyselyTransaction,
  ): Promise<void> {
    await this.requireActive(userId, workspaceId, trx);
    await this.userRepo.updateUser({ name }, userId, workspaceId, trx);
  }

  async softDelete(
    userId: string,
    workspaceId: string,
    trx: KyselyTransaction,
  ): Promise<void> {
    await this.requireActive(userId, workspaceId, trx);
    await this.userRepo.updateUser(
      { deletedAt: new Date() },
      userId,
      workspaceId,
      trx,
    );
  }
}
