import { IsString, IsUrl, Matches } from 'class-validator';

export class UpdateSkillSettingsDto {
  @IsString()
  @Matches(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  latestVersion: string;

  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  upgradeUrl: string;
}
