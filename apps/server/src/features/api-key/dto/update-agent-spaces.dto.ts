import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class UpdateAgentSpacesDto {
  @IsUUID()
  apiKeyId: string;

  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  spaceIds: string[];
}
