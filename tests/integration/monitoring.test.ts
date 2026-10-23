import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { DeleteQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import { SubmitWager } from '../../src/application/wagering/submit-wager';
import { RetryPendingReferences } from '../../src/application/wagering/retry-pending-references';
import { PublishOutbox } from '../../src/application/events/publish-outbox';
import { ApplicationMetrics } from '../../src/infrastructure/observability/application-metrics';
import { PostgresWageringUnitOfWork } from '../../src/infrastructure/persistence/repositories/postgres-wagering-unit-of-work';
import { WagerQueueConsumer } from '../../src/infrastructure/messaging/wager-queue.consumer';
import { WagerTransactionKind } from '../../src/domain/entities/wager-transaction';
import { createTestDatabase } from '../support/postgres-test-database';
import { createTestQueue } from '../support/sqs-test-queue';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let queues: Awaited<ReturnType<typeof createTestQueue>>[];
let app: INestApplication;
let base: string;
const names = [
  'DATABASE_URL',
  'SQS_ENDPOINT',
  'SQS_TRANSACTIONS_QUEUE_URL',
  'SQS_TRANSACTIONS_DLQ_URL',
  'SQS_EVENTS_QUEUE_URL',
] as const;
let previous: Record<string, string | undefined>;

beforeEach(async () => {
  previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  database = await createTestDatabase();
  queues = await Promise.all([
    createTestQueue(),
    createTestQueue(),
    createTestQueue(),
  ]);
  process.env.DATABASE_URL = database.url;
  process.env.SQS_ENDPOINT =
    process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4567';
  process.env.SQS_TRANSACTIONS_QUEUE_URL = queues[0]!.queueUrl;
  process.env.SQS_TRANSACTIONS_DLQ_URL = queues[1]!.queueUrl;
  process.env.SQS_EVENTS_QUEUE_URL = queues[2]!.queueUrl;
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
}, 30000);

afterEach(async () => {
  await app?.close();
  for (const queue of queues ?? []) {
    try {
      await queue.close();
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        ![
          'QueueDoesNotExist',
          'AWS.SimpleQueueService.NonExistentQueue',
        ].includes(error.name)
      ) {
        throw error;
      }
    }
  }
  await database?.close();
  for (const name of names) {
    const value = previous[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

async function input() {
  const wallet = await app.get(OpenWallet).execute({
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  return {
    walletId: wallet.id,
    playerId: wallet.playerId,
    providerId: 'provider-monitoring',
    externalTransactionId: randomUUID(),
    gameId: 'game',
    roundId: 'round',
    kind: WagerTransactionKind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  };
}
async function metrics() {
  const response = await fetch(`${base}/metrics`);
  expect(response.status).toBe(200);
  return response.text();
}

test('public readiness verifies PostgreSQL and all queues while liveness stays independent', async () => {
  expect((await fetch(`${base}/health/live`)).status).toBe(200);
  const ready = await fetch(`${base}/health/ready`);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({
    status: 'ok',
    checks: { postgres: 'up', sqs: 'up' },
  });
  const events = queues[2]!;
  await events.client.send(
    new DeleteQueueCommand({ QueueUrl: events.queueUrl }),
  );
  const unavailable = await fetch(`${base}/health/ready`);
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({
    status: 'unavailable',
    checks: { postgres: 'up', sqs: 'down' },
  });
  expect((await fetch(`${base}/health/live`)).status).toBe(200);
});

test('PostgreSQL failure affects readiness and metrics without failing liveness', async () => {
  await app.get(MikroORM).close(true);
  expect((await fetch(`${base}/health/ready`)).status).toBe(503);
  expect((await fetch(`${base}/metrics`)).status).toBe(503);
  expect((await fetch(`${base}/health/live`)).status).toBe(200);
});

test('committed status transitions, duplicate replays, latency and live outbox lag are exposed', async () => {
  const wager = await input();
  const submit = app.get(SubmitWager);
  const key = randomUUID();
  await submit.execute(wager, key, { correlationId: 'metrics-test' });
  await submit.execute(wager, key, { correlationId: 'metrics-test' });
  let output = await metrics();
  expect(output).toContain(
    'wager_transactions_total{status="PROCESSED",kind="BET"} 1',
  );
  expect(output).toContain(
    'wager_transactions_total{status="PROCESSED",kind="OPENING"} 1',
  );
  expect(output).toContain('wager_duplicates_total 1');
  expect(output).toContain('wager_processing_duration_seconds_count 3');
  expect(output).toContain('outbox_pending_messages 4');
  expect(output).toMatch(/outbox_lag_seconds [\d.]+/);
  expect(output).not.toContain(wager.walletId);
  expect(output).not.toContain('100.00');
  await app.get(PublishOutbox).execute();
  output = await metrics();
  expect(output).toContain('outbox_pending_messages 0');
  expect(output).toContain('outbox_lag_seconds 0');
});

test('a rolled-back write is not counted as a committed transaction', async () => {
  const wager = await input();
  await database.orm.em.execute(`
    create function fail_monitoring() returns trigger language plpgsql as $$
    begin raise exception 'injected failure' using errcode = '40001'; end $$;
    create trigger fail_monitoring before insert on outbox_messages for each row execute function fail_monitoring();
  `);
  const response = await fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-correlation-id': 'rollback-metrics',
    },
    body: JSON.stringify(wager),
  });
  expect(response.status).toBe(503);
  const output = await metrics();
  expect(output).not.toContain('kind="BET"} 1');
  expect(output).toContain('database_lock_conflicts_total{code="40001"} 1');
  expect(output).toContain('outbox_pending_messages 2');
});

test('queue retries, DLQ sends and publisher retries increment operational metrics', async () => {
  const wager = await input();
  const source = queues[0]!;
  await database.orm.em.execute(`
    create function fail_monitoring() returns trigger language plpgsql as $$
    begin raise exception 'injected failure' using errcode = '40001'; end $$;
    create trigger fail_monitoring before insert on outbox_messages for each row execute function fail_monitoring();
  `);
  await source.client.send(
    new SendMessageCommand({
      QueueUrl: source.queueUrl,
      MessageGroupId: 'one',
      MessageDeduplicationId: randomUUID(),
      MessageBody: JSON.stringify({
        messageId: 'metrics-message',
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...wager, idempotencyKey: randomUUID() },
      }),
    }),
  );
  const observer = app.get(ApplicationMetrics);
  const consumer = new WagerQueueConsumer(
    source.client,
    source.queueUrl,
    queues[1]!.queueUrl,
    new SubmitWager(
      new PostgresWageringUnitOfWork(database.orm, observer),
      observer,
    ),
    { waitTimeSeconds: 0 },
    observer,
  );
  expect((await consumer.processNext()).outcome).toBe('RETRY');
  await source.client.send(
    new SendMessageCommand({
      QueueUrl: source.queueUrl,
      MessageGroupId: 'two',
      MessageDeduplicationId: randomUUID(),
      MessageBody: '{invalid',
    }),
  );
  expect((await consumer.processNext()).outcome).toBe('DEAD_LETTERED');
  const events = queues[2]!;
  await events.client.send(
    new DeleteQueueCommand({ QueueUrl: events.queueUrl }),
  );
  await app.get(PublishOutbox).execute();
  const output = await metrics();
  expect(output).toContain('processing_retries_total{component="sqs"} 1');
  expect(output).toContain('processing_retries_total{component="outbox"} 2');
  expect(output).toContain('sqs_dead_lettered_total 1');
});

test('pending reference retries do not inflate status transitions and expiration is observable', async () => {
  const wager = await input();
  await app.get(SubmitWager).execute(
    {
      ...wager,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'missing-reference',
    },
    randomUUID(),
  );
  await app.get(RetryPendingReferences).execute(new Date(Date.now() + 2000));
  let output = await metrics();
  expect(output).toContain(
    'wager_transactions_total{status="PENDING_REFERENCE",kind="REFUND"} 1',
  );
  expect(output).toContain('processing_retries_total{component="reference"} 1');
  await app
    .get(RetryPendingReferences)
    .execute(new Date(Date.now() + 86401000));
  output = await metrics();
  expect(output).toContain(
    'wager_transactions_total{status="REJECTED",kind="REFUND"} 1',
  );
  expect(output).toContain(
    'wager_transactions_total{status="PENDING_REFERENCE",kind="REFUND"} 1',
  );
});
