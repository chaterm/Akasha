import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@akasha/db/types/kysely.types';
import { executeTx } from '@akasha/db/utils';
import { sql } from 'kysely';
import { GroupService } from '../../core/group/services/group.service';
import { GroupRepo } from '@akasha/db/repos/group/group.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import { WorkspaceRepo } from '@akasha/db/repos/workspace/workspace.repo';
import {
  CreateGroupDto,
  CreateGroupSpacePermissionDto,
  DeleteGroupDto,
  GroupMembersDto,
  GroupNameDto,
  GroupSpacePermissionDto,
  ListGroupDto,
  ListGroupUserDto,
  ListUserGroupDto,
  UpdateGroupDto,
  UpdateGroupSpacePermissionDto,
} from './dto/sso-arch.dto';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

@Injectable()
export class SsoGroupService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly groupRepo: GroupRepo,
    private readonly groupService: GroupService,
    private readonly spaceRepo: SpaceRepo,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  private async lockGroupNames(
    trx: KyselyTransaction,
    workspaceId: string,
    groupNames: string[],
  ): Promise<void> {
    const names = [
      ...new Set(groupNames.map((name) => name.toLowerCase())),
    ].sort();
    for (const name of names) {
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${`sso-group:${workspaceId}:${name}`})
        )
      `.execute(trx);
    }
  }

  private async workspaceId(): Promise<string> {
    const workspace = await this.workspaceRepo.findFirst();
    if (!workspace) throw new NotFoundException('Workspace not initialized');
    return workspace.id;
  }

  async ListGroup(dto: ListGroupDto) {
    const workspaceId = await this.workspaceId();
    let query = this.db
      .selectFrom('groups')
      .select([
        'id',
        'name',
        'description',
        'isExternal',
        'workspaceId',
        'createdAt',
        'updatedAt',
      ])
      .where('workspaceId', '=', workspaceId)
      .where('isExternal', '=', true)
      .where('isDefault', '=', false)
      .where('deletedAt', 'is', null)
      .orderBy('name', 'asc')
      .limit(dto.limit ?? 100);
    if (dto.query) query = query.where('name', 'ilike', `%${dto.query}%`);
    return query.execute();
  }

  async CreateGroup(dto: CreateGroupDto) {
    const workspaceId = await this.workspaceId();
    return executeTx(this.db, async (trx) => {
      await this.lockGroupNames(trx, workspaceId, dto.groupNames);
      const groups = [];
      for (const name of dto.groupNames) {
        const existing = await this.groupRepo.findByName(name, workspaceId, {
          trx,
        });
        if (existing) {
          if (!existing.isExternal || existing.isDefault) {
            throw new ConflictException(`Group name already exists: ${name}`);
          }
          groups.push(existing);
          continue;
        }
        const created = await this.groupRepo.insertGroup(
          {
            name,
            description: null,
            isDefault: false,
            isExternal: true,
            creatorId: null,
            workspaceId,
          },
          trx,
        );
        groups.push(created);
        this.auditService.log({
          event: AuditEvent.GROUP_CREATED,
          resourceType: AuditResource.GROUP,
          resourceId: created.id,
          changes: { after: { name: created.name, isExternal: true } },
        });
      }
      return groups;
    });
  }

  async UpdateGroup(dto: UpdateGroupDto) {
    const workspaceId = await this.workspaceId();
    return executeTx(this.db, async (trx) => {
      await this.lockGroupNames(trx, workspaceId, [
        dto.oldGroupName,
        dto.newGroupName,
      ]);
      const group = await this.groupRepo.findByName(
        dto.oldGroupName,
        workspaceId,
        { trx },
      );
      if (!group) return;
      if (!group.isExternal || group.isDefault) {
        throw new ConflictException('Only external groups can be updated');
      }
      const existing = await this.groupRepo.findByName(
        dto.newGroupName,
        workspaceId,
        { trx },
      );
      if (existing && existing.id !== group.id) {
        throw new ConflictException('Group name already exists');
      }
      await this.groupRepo.update(
        { name: dto.newGroupName },
        group.id,
        workspaceId,
        trx,
      );
      this.auditService.log({
        event: AuditEvent.GROUP_UPDATED,
        resourceType: AuditResource.GROUP,
        resourceId: group.id,
        changes: {
          before: { name: group.name },
          after: { name: dto.newGroupName },
        },
      });
      return { id: group.id, name: dto.newGroupName };
    });
  }

  async DeleteGroup(dto: DeleteGroupDto): Promise<void> {
    const workspaceId = await this.workspaceId();
    for (const name of dto.groupNames) {
      const group = await this.groupRepo.findByName(name, workspaceId);
      if (!group) continue;
      if (!group.isExternal || group.isDefault) {
        throw new ConflictException('Only external groups can be deleted');
      }
      await this.groupService.deleteGroup(group.id, workspaceId);
    }
  }

  async ListUserGroup(dto: ListUserGroupDto) {
    const workspaceId = await this.workspaceId();
    return this.db
      .selectFrom('groupUsers')
      .innerJoin('users', 'users.id', 'groupUsers.userId')
      .innerJoin('groups', 'groups.id', 'groupUsers.groupId')
      .select(['groups.id', 'groups.name'])
      .where('users.workspaceId', '=', workspaceId)
      .where('groups.workspaceId', '=', workspaceId)
      .where('groups.isExternal', '=', true)
      .where('groups.isDefault', '=', false)
      .where('users.deletedAt', 'is', null)
      .where(sql`LOWER(users.email)`, '=', dto.email.toLowerCase())
      .orderBy('groups.name', 'asc')
      .execute();
  }

  private async externalGroup(name: string) {
    const workspaceId = await this.workspaceId();
    const group = await this.groupRepo.findByName(name, workspaceId);
    if (!group || !group.isExternal || group.isDefault) {
      throw new NotFoundException('External group not found');
    }
    return { group, workspaceId };
  }

  async ListGroupUser(dto: ListGroupUserDto) {
    const { group, workspaceId } = await this.externalGroup(dto.groupName);
    return this.db
      .selectFrom('groupUsers')
      .innerJoin('users', 'users.id', 'groupUsers.userId')
      .select(['users.id', 'users.email', 'users.name', 'users.avatarUrl'])
      .where('groupUsers.groupId', '=', group.id)
      .where('users.workspaceId', '=', workspaceId)
      .where('users.deletedAt', 'is', null)
      .orderBy('users.email', 'asc')
      .limit(dto.limit ?? 500)
      .execute();
  }

  async CreateGroupUser(dto: GroupMembersDto): Promise<void> {
    const { group, workspaceId } = await this.externalGroup(dto.groupName);
    const emails = dto.emails.map((email) => email.toLowerCase());
    await executeTx(this.db, async (trx) => {
      const users = await trx
        .selectFrom('users')
        .select('id')
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .where(sql`LOWER(email)`, 'in', emails)
        .execute();
      if (users.length === 0) return;
      await trx
        .insertInto('groupUsers')
        .values(users.map((user) => ({ userId: user.id, groupId: group.id })))
        .onConflict((oc) => oc.columns(['userId', 'groupId']).doNothing())
        .execute();
    });
    this.auditService.log({
      event: AuditEvent.GROUP_MEMBER_ADDED,
      resourceType: AuditResource.GROUP,
      resourceId: group.id,
      metadata: { emails },
    });
  }

  async DeleteGroupUser(dto: GroupMembersDto): Promise<void> {
    const { group, workspaceId } = await this.externalGroup(dto.groupName);
    const emails = dto.emails.map((email) => email.toLowerCase());
    await executeTx(this.db, async (trx) => {
      await trx
        .deleteFrom('groupUsers')
        .where('groupId', '=', group.id)
        .where(
          'userId',
          'in',
          trx
            .selectFrom('users')
            .select('id')
            .where('workspaceId', '=', workspaceId)
            .where(sql`LOWER(email)`, 'in', emails),
        )
        .execute();
    });
    this.auditService.log({
      event: AuditEvent.GROUP_MEMBER_REMOVED,
      resourceType: AuditResource.GROUP,
      resourceId: group.id,
      metadata: { emails },
    });
  }

  async ListGroupSpacePermission(dto: GroupNameDto) {
    const { group, workspaceId } = await this.externalGroup(dto.groupName);
    return this.db
      .selectFrom('spaceMembers')
      .innerJoin('spaces', 'spaces.id', 'spaceMembers.spaceId')
      .select([
        'spaces.id as spaceId',
        'spaces.slug as spaceSlug',
        'spaces.name as spaceName',
        'spaceMembers.role',
      ])
      .where('spaceMembers.groupId', '=', group.id)
      .where('spaces.workspaceId', '=', workspaceId)
      .where('spaces.deletedAt', 'is', null)
      .orderBy('spaces.slug', 'asc')
      .execute();
  }

  async CreateGroupSpacePermission(dto: CreateGroupSpacePermissionDto) {
    const { group, workspaceId } = await this.externalGroup(dto.groupName);
    const space = await this.spaceRepo.findBySlug(dto.spaceSlug, workspaceId);
    if (!space) throw new NotFoundException('Space not found');
    await executeTx(this.db, async (trx) => {
      await trx
        .insertInto('spaceMembers')
        .values({ groupId: group.id, spaceId: space.id, role: dto.role })
        .onConflict((oc) => oc.columns(['spaceId', 'groupId']).doNothing())
        .execute();
    });
    this.auditService.log({
      event: AuditEvent.SPACE_MEMBER_ADDED,
      resourceType: AuditResource.SPACE_MEMBER,
      resourceId: space.id,
      spaceId: space.id,
      changes: { after: { role: dto.role } },
      metadata: { groupId: group.id, groupName: group.name },
    });
  }

  async UpdateGroupSpacePermission(dto: UpdateGroupSpacePermissionDto) {
    const { group, workspaceId } = await this.externalGroup(dto.groupName);
    const space = await this.spaceRepo.findBySlug(dto.spaceSlug, workspaceId);
    if (!space) throw new NotFoundException('Space not found');
    const result = await this.db
      .updateTable('spaceMembers')
      .set({ role: dto.role, updatedAt: new Date() })
      .where('groupId', '=', group.id)
      .where('spaceId', '=', space.id)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw new NotFoundException('Group space permission not found');
    }
    this.auditService.log({
      event: AuditEvent.SPACE_MEMBER_ROLE_CHANGED,
      resourceType: AuditResource.SPACE_MEMBER,
      resourceId: space.id,
      spaceId: space.id,
      changes: { after: { role: dto.role } },
      metadata: { groupId: group.id, groupName: group.name },
    });
  }

  async DeleteGroupSpacePermission(
    dto: GroupSpacePermissionDto,
  ): Promise<void> {
    const { group, workspaceId } = await this.externalGroup(dto.groupName);
    const space = await this.spaceRepo.findBySlug(dto.spaceSlug, workspaceId);
    if (!space) return;
    await executeTx(this.db, async (trx) => {
      await trx
        .deleteFrom('spaceMembers')
        .where('groupId', '=', group.id)
        .where('spaceId', '=', space.id)
        .execute();
    });
    this.auditService.log({
      event: AuditEvent.SPACE_MEMBER_REMOVED,
      resourceType: AuditResource.SPACE_MEMBER,
      resourceId: space.id,
      spaceId: space.id,
      metadata: { groupId: group.id, groupName: group.name },
    });
  }
}
