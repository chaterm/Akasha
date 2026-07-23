import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AbilityBuilder,
  createMongoAbility,
  MongoAbility,
} from '@casl/ability';
import { SpaceRole, UserRole } from '../../../common/helpers/types/permission';
import { User } from '@akasha/db/types/entity.types';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import {
  SpaceCaslAction,
  ISpaceAbility,
  SpaceCaslSubject,
} from '../interfaces/space-ability.type';
import { findHighestUserSpaceRole } from '@akasha/db/repos/space/utils';
import { isOrdinaryApiKeySpaceReadOnly } from '../../../common/auth/api-key-access';

@Injectable()
export default class SpaceAbilityFactory {
  constructor(private readonly spaceMemberRepo: SpaceMemberRepo) {}
  async createForUser(user: User, spaceId: string) {
    // Workspace owner has full admin access to all spaces
    if (user.role === UserRole.OWNER) {
      return buildSpaceAdminAbility();
    }

    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      user.id,
      spaceId,
    );

    const userSpaceRole = findHighestUserSpaceRole(userSpaceRoles);
    const apiKeyReadOnly = isOrdinaryApiKeySpaceReadOnly(user, spaceId);

    switch (userSpaceRole) {
      case SpaceRole.ADMIN:
        return apiKeyReadOnly
          ? buildSpaceReaderAbility()
          : buildSpaceAdminAbility();
      case SpaceRole.WRITER:
        return apiKeyReadOnly
          ? buildSpaceReaderAbility()
          : buildSpaceWriterAbility();
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
