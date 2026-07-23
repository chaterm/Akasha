import { Injectable } from '@nestjs/common';
import { SpaceMemberRepo } from '@akasha/db/repos/space/space-member.repo';
import {
  SpaceRole,
  UserRole,
} from '../../../common/helpers/types/permission';

@Injectable()
export class SpaceAuthorizationService {
  constructor(private readonly spaceMemberRepo: SpaceMemberRepo) {}

  async filterReadableSpaceIds(input: {
    user: { id: string; role: string; workspaceId: string };
    spaceIds: string[];
  }): Promise<string[]> {
    if (input.spaceIds.length === 0) return [];

    if (input.user.role === UserRole.OWNER) {
      return input.spaceIds;
    }

    const roles = await this.spaceMemberRepo.findUserSpaceRolesForSpaces({
      userId: input.user.id,
      spaceIds: input.spaceIds,
    });
    const readableRoles = new Set<string>([
      SpaceRole.ADMIN,
      SpaceRole.WRITER,
      SpaceRole.READER,
    ]);
    const readableSpaceIds = new Set(
      roles
        .filter((role) => readableRoles.has(role.role))
        .map((role) => role.spaceId),
    );

    return input.spaceIds.filter((spaceId) => readableSpaceIds.has(spaceId));
  }
}
