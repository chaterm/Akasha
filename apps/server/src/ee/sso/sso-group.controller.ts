import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SsoArchAuthGuard } from './guards/sso-arch-auth.guard';
import { SsoGroupService } from './sso-group.service';
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

@UseGuards(SsoArchAuthGuard)
@Controller('sso/groups')
export class SsoGroupController {
  constructor(private readonly ssoGroupService: SsoGroupService) {}

  @Post()
  ListGroup(@Body() dto: ListGroupDto) {
    return this.ssoGroupService.ListGroup(dto);
  }

  @Post('create')
  CreateGroup(@Body() dto: CreateGroupDto) {
    return this.ssoGroupService.CreateGroup(dto);
  }

  @Post('update')
  UpdateGroup(@Body() dto: UpdateGroupDto) {
    return this.ssoGroupService.UpdateGroup(dto);
  }

  @Post('delete')
  DeleteGroup(@Body() dto: DeleteGroupDto) {
    return this.ssoGroupService.DeleteGroup(dto);
  }

  @Post('user-groups')
  ListUserGroup(@Body() dto: ListUserGroupDto) {
    return this.ssoGroupService.ListUserGroup(dto);
  }

  @Post('members')
  ListGroupUser(@Body() dto: ListGroupUserDto) {
    return this.ssoGroupService.ListGroupUser(dto);
  }

  @Post('members/add')
  CreateGroupUser(@Body() dto: GroupMembersDto) {
    return this.ssoGroupService.CreateGroupUser(dto);
  }

  @Post('members/remove')
  DeleteGroupUser(@Body() dto: GroupMembersDto) {
    return this.ssoGroupService.DeleteGroupUser(dto);
  }

  @Post('space-permissions')
  ListGroupSpacePermission(@Body() dto: GroupNameDto) {
    return this.ssoGroupService.ListGroupSpacePermission(dto);
  }

  @Post('space-permissions/add')
  CreateGroupSpacePermission(@Body() dto: CreateGroupSpacePermissionDto) {
    return this.ssoGroupService.CreateGroupSpacePermission(dto);
  }

  @Post('space-permissions/change-role')
  UpdateGroupSpacePermission(@Body() dto: UpdateGroupSpacePermissionDto) {
    return this.ssoGroupService.UpdateGroupSpacePermission(dto);
  }

  @Post('space-permissions/remove')
  DeleteGroupSpacePermission(@Body() dto: GroupSpacePermissionDto) {
    return this.ssoGroupService.DeleteGroupSpacePermission(dto);
  }
}
