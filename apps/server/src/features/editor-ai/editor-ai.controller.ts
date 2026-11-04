import {
  Body,
  Controller,
  ForbiddenException,
  HttpException,
  HttpCode,
  HttpStatus,
  Post,
  Logger,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Workspace } from '@akasha/db/types/entity.types';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { EditorAiGenerateDto } from './dto/editor-ai.dto';
import { EditorAiService } from './editor-ai.service';
import {
  ErrorCode,
  errorBody,
  readErrorCode,
} from '../../common/errors/error-codes';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class EditorAiController {
  private readonly logger = new Logger(EditorAiController.name);

  constructor(private readonly editorAiService: EditorAiService) {}

  @HttpCode(HttpStatus.OK)
  @Post('generate')
  async generate(
    @Body() dto: EditorAiGenerateDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    assertGenerativeAiEnabled(workspace);
    return this.editorAiService.generate(dto);
  }

  @Post('generate/stream')
  async stream(
    @Body() dto: EditorAiGenerateDto,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: SseReply,
  ): Promise<void> {
    assertGenerativeAiEnabled(workspace);
    prepareSse(res);
    const raw = getRawResponse(res);
    const abortController = new AbortController();
    const handleDisconnect = () =>
      abortController.abort(new Error('Client disconnected.'));
    raw.once?.('close', handleDisconnect);

    try {
      for await (const content of this.editorAiService.stream(dto, {
        abortSignal: abortController.signal,
      })) {
        writeSse(res, { content });
      }
      writeRaw(res, 'data: [DONE]\n\n');
    } catch (error) {
      if (!abortController.signal.aborted) {
        this.logger.error(
          'Editor AI generation failed',
          error instanceof Error ? error.stack : String(error),
        );
        writeSse(res, {
          error:
            error instanceof HttpException
              ? error.message
              : 'AI generation failed.',
          code: readErrorCode(error),
        });
      }
    } finally {
      raw.off?.('close', handleDisconnect);
      if (!raw.writableEnded && !raw.destroyed) {
        raw.end();
      }
    }
  }
}

export function isGenerativeAiEnabledForWorkspace(
  workspace: Workspace,
): boolean {
  const settings = workspace.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return false;
  }
  const ai = (settings as Record<string, unknown>).ai;
  return (
    !!ai &&
    typeof ai === 'object' &&
    !Array.isArray(ai) &&
    (ai as Record<string, unknown>).generative === true
  );
}

function assertGenerativeAiEnabled(workspace: Workspace): void {
  if (!isGenerativeAiEnabledForWorkspace(workspace)) {
    throw new ForbiddenException(
      errorBody(ErrorCode.AI_GENERATIVE_DISABLED, 'Generative AI is disabled.'),
    );
  }
}

function prepareSse(res: SseReply): void {
  const raw = getRawResponse(res);
  raw.setHeader('Content-Type', 'text/event-stream');
  raw.setHeader('Cache-Control', 'no-cache, no-transform');
  raw.setHeader('Connection', 'keep-alive');
  raw.setHeader('X-Accel-Buffering', 'no');
  raw.flushHeaders?.();
}

type SseRawResponse = {
  setHeader: (name: string, value: string) => void;
  write: (payload: string) => void;
  end: () => void;
  flushHeaders?: () => void;
  once?: (event: 'close', listener: () => void) => void;
  off?: (event: 'close', listener: () => void) => void;
  writableEnded?: boolean;
  destroyed?: boolean;
};

type SseReply = SseRawResponse | { raw: SseRawResponse };

function writeSse(res: SseReply, event: Record<string, unknown>): void {
  writeRaw(res, `data: ${JSON.stringify(event)}\n\n`);
}

function writeRaw(res: SseReply, payload: string): void {
  getRawResponse(res).write(payload);
}

function getRawResponse(res: SseReply): SseRawResponse {
  return 'raw' in res ? res.raw : res;
}
