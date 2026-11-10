import { IsUUID } from 'class-validator';

export class AgentApiKeyIdDto {
  @IsUUID()
  apiKeyId: string;
}
