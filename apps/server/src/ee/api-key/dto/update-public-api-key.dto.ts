import { IsString } from 'class-validator';
import { CreatePublicApiKeyDto } from './create-public-api-key.dto';

export class UpdatePublicApiKeyDto extends CreatePublicApiKeyDto {
  @IsString()
  apiKeyId: string;
}
