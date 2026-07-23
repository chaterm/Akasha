import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationOptions } from '@akasha/db/pagination/pagination-options';

export class SendAiChatMessageDto {
  @IsOptional()
  @IsString()
  chatId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mentionedPageIds?: string[];

  @IsOptional()
  @IsString()
  contextPageId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentIds?: string[];
}

export class ChatIdDto {
  @IsString()
  chatId: string;
}

export class UpdateAiChatTitleDto extends ChatIdDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;
}

export class SearchAiChatsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  query: string;
}

export class ListAiChatsDto extends PaginationOptions {}
