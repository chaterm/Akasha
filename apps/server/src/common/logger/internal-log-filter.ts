import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { IGNORED_LOG_CONTEXTS } from './ignored-contexts';
import { resolveLogLevel } from './pino.config';

const LEVEL_ORDER: Record<string, number> = {
  trace: 10,
  verbose: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export class InternalLogFilter extends ConsoleLogger {
  private readonly threshold: number;

  constructor() {
    super({ json: process.env.NODE_ENV === 'production' });
    this.threshold = LEVEL_ORDER[resolveLogLevel()] ?? LEVEL_ORDER.info;
  }

  private isLogLevelAllowed(level: string): boolean {
    return (LEVEL_ORDER[level] ?? LEVEL_ORDER.info) >= this.threshold;
  }

  log(_: any, context?: string): void {
    if (
      this.isLogLevelAllowed('info') &&
      !IGNORED_LOG_CONTEXTS.includes(context)
    ) {
      super.log.apply(this, arguments);
    }
  }

  warn(_: any, context?: string): void {
    if (this.isLogLevelAllowed('warn')) {
      super.warn.apply(this, arguments);
    }
  }

  error(_: any, stack?: string, context?: string): void {
    if (this.isLogLevelAllowed('error')) {
      super.error.apply(this, arguments);
    }
  }

  debug(_: any, context?: string): void {
    if (this.isLogLevelAllowed('debug')) {
      super.debug.apply(this, arguments);
    }
  }

  verbose(_: any, context?: string): void {
    if (this.isLogLevelAllowed('verbose')) {
      super.verbose.apply(this, arguments);
    }
  }

  protected printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    const level = logLevel === 'log' ? ('info' as LogLevel) : logLevel;
    super.printMessages(messages, context, level, writeStreamType, errorStack);
  }
}
