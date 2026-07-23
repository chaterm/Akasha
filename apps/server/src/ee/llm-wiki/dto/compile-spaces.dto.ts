import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class CompileSpacesDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  spaceIds: string[];
}
