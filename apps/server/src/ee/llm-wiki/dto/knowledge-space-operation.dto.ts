import { IsString, MaxLength } from 'class-validator';

export class KnowledgeSpaceOperationDto {
  @IsString()
  @MaxLength(255)
  confirmationSpaceName: string;
}
