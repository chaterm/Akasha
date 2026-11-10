import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * Owner-facing payload for rebinding an agent key's spaces from the workspace
 * settings page. Unlike the business-facing iself endpoint (which infers the
 * key from the authenticated agent credential), the owner must name the target
 * key explicitly via `apiKeyId`.
 */
export class UpdateAgentSpacesDto {
  @IsUUID()
  apiKeyId: string;

  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  spaceIds: string[];
}
