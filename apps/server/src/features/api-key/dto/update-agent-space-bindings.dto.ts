import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class UpdateAgentSpaceBindingsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  spaceIds: string[];
}
