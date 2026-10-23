import {
  JsonLogger,
  writeOperationalLog,
} from './infrastructure/observability/json-logger';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const rawPort = process.env.PORT ?? '3000';

  if (!/^\d+$/.test(rawPort)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.enableShutdownHooks();
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch(() => {
  writeOperationalLog('error', { code: 'STARTUP_FAILED' });
  process.exitCode = 1;
});
