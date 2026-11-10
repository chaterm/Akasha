import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Payload for the platform-to-platform agent API-key provisioning endpoint.
 * `agent_id` is supplied by the calling platform and becomes the stable
 * identifier embedded in the agent user's email; `agent_name` is the display
 * name for both the agent user and the API key.
 */
export class CreateIselfAgentApiKeyDto {
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(100)
  agent_id: string;

  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(100)
  agent_name: string;
}
