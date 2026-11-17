import { NestFactory, Reflector } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { TransformHttpResponseInterceptor } from '../../common/interceptors/http-response.interceptor';
import { Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { InternalLogFilter } from '../../common/logger/internal-log-filter';
import { loadRuntimeConfiguration } from '../../integrations/environment/consul-config.loader';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { bootstrapLogger } from '../../common/logger/bootstrap-logger';
import { SERVICE_NAME_COLLAB } from '../../common/logger/log-service-name';

async function bootstrap() {
  process.env.SERVICE_NAME ??= SERVICE_NAME_COLLAB;
  await loadRuntimeConfiguration();
  const { CollabAppModule } = await import('./collab-app.module');

  const app = await NestFactory.create<NestFastifyApplication>(
    CollabAppModule,
    new FastifyAdapter({
      routerOptions: {
        maxParamLength: 1000,
        ignoreTrailingSlash: true,
        ignoreDuplicateSlashes: true,
      },
    }),
    {
      logger: new InternalLogFilter(),
      bufferLogs: false,
    },
  );

  app.useLogger(app.get(PinoLogger));

  app.useGlobalFilters(
    new AllExceptionsFilter(app.getHttpAdapter(), app.get(PinoLogger)),
  );

  app.setGlobalPrefix('api', { exclude: ['/'] });

  app.enableCors();

  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(new TransformHttpResponseInterceptor(reflector));
  app.enableShutdownHooks();

  const logger = new Logger('CollabServer');

  const port = process.env.COLLAB_PORT || 3001;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host, () => {
    logger.log({ port, host }, 'Collaboration server listening');
  });
}

bootstrap().catch((error) => {
  bootstrapLogger.fatal({
    context: 'CollabBootstrap',
    msg: 'Failed to bootstrap Akasha collaboration server',
    err: error,
  });
  process.exit(1);
});
