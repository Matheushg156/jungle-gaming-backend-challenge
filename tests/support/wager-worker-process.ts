import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { SubmitWager } from '../../src/application/wagering/submit-wager';

async function run() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  const submit = app.get(SubmitWager);
  const execute = submit.execute.bind(submit);
  submit.execute = async (...args) => {
    process.stdout.write('RECEIVED\n');
    // A controlled in-flight pause lets the parent signal SIGTERM before commit.
    await Bun.stdin.text();
    return execute(...args);
  };
  await app.init();
  process.stdout.write('READY\n');
}

run().catch(() => {
  console.error('Worker process failed');
  process.exitCode = 1;
});
