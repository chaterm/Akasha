import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
} from '@casl/ability';
import {
  isWorkspaceAdmin,
  SpaceRole,
} from '../../../common/helpers/types/permission';
import { User } from '@akasha/db/types/entity.types';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import { SpaceRepo } from '@akasha/db/repos/space/space.repo';
import {
  SpaceCaslAction,
  ISpaceAbility,
  SpaceCaslSubject,
} from '../interfaces/space-ability.type';
import { findHighestUserSpaceRole } from '@akasha/db/repos/space/utils';

@Injectable()
export default class SpaceAbilityFactory {
  constructor(
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly spaceRepo: SpaceRepo,
  ) {}
  async createForUser(user: User, spaceId: string) {
    if (isWorkspaceAdmin(user.role)) {
      const space = await this.spaceRepo.findById(spaceId, user.workspaceId);
      if (!space) {
        throw new NotFoundException('Space not found');
      }
      return buildSpaceAdminAbility();
    }

    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      user.id,
      spaceId,
    );

    const userSpaceRole = findHighestUserSpaceRole(userSpaceRoles);

    switch (userSpaceRole) {
      case SpaceRole.ADMIN:
        return buildSpaceAdminAbility();
      case SpaceRole.WRITER:
        return buildSpaceWriterAbility();
      case SpaceRole.READER:
        return buildSpaceReaderAbility();
      default:
        throw new NotFoundException('Space permissions not found');
    }
  }
}

function buildSpaceAdminAbility() {
  const { can, build } = new AbilityBuilder<MongoAbility<ISpaceAbility>>(
    createMongoAbility,
  );
  can(SpaceCaslAction.Manage, SpaceCaslSubject.Settings);
  can(SpaceCaslAction.Manage, SpaceCaslSubject.Member);
  can(SpaceCaslAction.Manage, SpaceCaslSubject.Page);
  can(SpaceCaslAction.Manage, SpaceCaslSubject.Share);
  return build();
}

function buildSpaceWriterAbility() {
  const { can, build } = new AbilityBuilder<MongoAbility<ISpaceAbility>>(
    createMongoAbility,
  );
  can(SpaceCaslAction.Read, SpaceCaslSubject.Settings);
  can(SpaceCaslAction.Read, SpaceCaslSubject.Member);
  can(SpaceCaslAction.Manage, SpaceCaslSubject.Page);
  can(SpaceCaslAction.Manage, SpaceCaslSubject.Share);
  return build();
}

function buildSpaceReaderAbility() {
  const { can, build } = new AbilityBuilder<MongoAbility<ISpaceAbility>>(
    createMongoAbility,
  );
  can(SpaceCaslAction.Read, SpaceCaslSubject.Settings);
  can(SpaceCaslAction.Read, SpaceCaslSubject.Member);
  can(SpaceCaslAction.Read, SpaceCaslSubject.Page);
  can(SpaceCaslAction.Read, SpaceCaslSubject.Share);
  return build();
}
