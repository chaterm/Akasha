import { IsString, MaxLength, MinLength } from 'class-validator';

export class CitationPageDto {
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  pageUrl: string;
}
