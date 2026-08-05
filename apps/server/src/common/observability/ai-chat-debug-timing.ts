import { randomUUID } from 'node:crypto';

type DebugLogger = {
  debug(message: unknown): void;
};

type TimingDetails = Record<string, unknown>;

/**
 * Request-scoped AI chat timing trace.
 *
 * The trace is only created when DEBUG_MODE=true. It intentionally records
 * identifiers, durations and counts, but never query text, answer text or
 * retrieved document content.
 */
export class AiChatDebugTiming {
  private readonly traceId = randomUUID();
  private readonly startedAt = performance.now();
  private readonly phaseDurationsMs = new Map<string, number>();
  private chatId?: string;
  private firstContentLogged = false;
  private completed = false;

  static create(
    logger: DebugLogger,
    details: { workspaceId: string; operation: 'send' | 'edit' },
  ): AiChatDebugTiming | undefined {
    if (process.env.DEBUG_MODE?.trim().toLowerCase() !== 'true') {
      return undefined;
    }

    const timing = new AiChatDebugTiming(logger, details.workspaceId);
    timing.write({
      phase: 'request.started',
      operation: details.operation,
      durationMs: 0,
    });
    return timing;
  }

  private constructor(
    private readonly logger: DebugLogger,
    private readonly workspaceId: string,
  ) {}

  setChatId(chatId: string): void {
    this.chatId = chatId;
  }

  async measure<T>(
    phase: string,
    operation: () => Promise<T>,
    details?: TimingDetails | ((result: T) => TimingDetails),
  ): Promise<T> {
    const phaseStartedAt = performance.now();
    try {
      const result = await operation();
      this.record(
        phase,
        performance.now() - phaseStartedAt,
        typeof details === 'function' ? details(result) : details,
      );
      return result;
    } catch (error) {
      this.record(phase, performance.now() - phaseStartedAt, {
        ...(typeof details === 'object' ? details : {}),
        status: 'error',
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }

  record(phase: string, durationMs: number, details?: TimingDetails): void {
    const roundedDurationMs = roundMs(durationMs);
    this.phaseDurationsMs.set(
      phase,
      roundMs((this.phaseDurationsMs.get(phase) ?? 0) + roundedDurationMs),
    );
    this.write({
      phase,
      durationMs: roundedDurationMs,
      status: 'ok',
      ...details,
    });
  }

  mark(phase: string, details?: TimingDetails): void {
    this.write({ phase, ...details });
  }

  markFirstContent(details?: TimingDetails): void {
    if (this.firstContentLogged) return;
    this.firstContentLogged = true;
    this.write({
      phase: 'response.first_content',
      timeToFirstContentMs: roundMs(performance.now() - this.startedAt),
      ...details,
    });
  }

  complete(details?: TimingDetails): void {
    if (this.completed) return;
    this.completed = true;
    this.write({
      phase: 'request.total',
      durationMs: roundMs(performance.now() - this.startedAt),
      phaseDurationsMs: Object.fromEntries(this.phaseDurationsMs),
      ...details,
    });
  }

  private write(details: TimingDetails): void {
    this.logger.debug({
      event: 'ai_chat_timing',
      traceId: this.traceId,
      workspaceId: this.workspaceId,
      ...(this.chatId ? { chatId: this.chatId } : {}),
      elapsedMs: roundMs(performance.now() - this.startedAt),
      ...details,
    });
  }
}

export async function measureAiChatPhase<T>(
  timing: AiChatDebugTiming | undefined,
  phase: string,
  operation: () => Promise<T>,
  details?: TimingDetails | ((result: T) => TimingDetails),
): Promise<T> {
  return timing ? timing.measure(phase, operation, details) : operation();
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}
