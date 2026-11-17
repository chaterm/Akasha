import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

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
