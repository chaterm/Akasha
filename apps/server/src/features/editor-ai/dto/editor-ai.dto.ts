import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const EDITOR_AI_ACTIONS = [
  'improve_writing',
  'fix_spelling_grammar',
  'make_shorter',
  'make_longer',
  'simplify',
  'change_tone',
  'summarize',
  'explain',
  'continue_writing',
  'translate',
  'custom',
  'generate',
] as const;

export type EditorAiAction = (typeof EDITOR_AI_ACTIONS)[number];

export class EditorAiMessageDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @MaxLength(20_000)
  content: string;
}

export class EditorAiGenerateDto {
  @IsOptional()
  @IsIn(EDITOR_AI_ACTIONS)
  action?: EditorAiAction;

  @IsString()
  @MaxLength(700_000)
  content: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  prompt?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EditorAiMessageDto)
  messages?: EditorAiMessageDto[];

  @IsOptional()
  @IsString()
  @MaxLength(700_000)
  pageContent?: string;
}
