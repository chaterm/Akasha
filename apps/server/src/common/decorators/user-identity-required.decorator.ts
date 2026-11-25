import { SetMetadata } from '@nestjs/common';

export const USER_IDENTITY_REQUIRED = 'userIdentityRequired';

export const UserIdentityRequired = () =>
  SetMetadata(USER_IDENTITY_REQUIRED, true);
