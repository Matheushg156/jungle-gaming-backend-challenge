import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';

async function run() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.init();
  process.stdout.write('READY\n');
}
run().catch(() => {
  console.error('Recovery worker failed');
  process.exitCode = 1;
});
