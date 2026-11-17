import { DynamicModule, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { createPinoConfig } from './pino.config';

@Module({})
export class LoggerModule {
  static forRoot(serviceName: string): DynamicModule {
    return {
      module: LoggerModule,
      imports: [PinoLoggerModule.forRoot(createPinoConfig(serviceName))],
      exports: [PinoLoggerModule],
    };
  }
}
