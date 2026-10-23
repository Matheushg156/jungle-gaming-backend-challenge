import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { rejects } from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import { SubmitWager } from '../../src/application/wagering/submit-wager';
import { RetryPendingReferences } from '../../src/application/wagering/retry-pending-references';
import { PublishOutbox } from '../../src/application/events/publish-outbox';
import { WagerTransactionKind as Kind } from '../../src/domain/entities/wager-transaction';
import type { EventEnvelope } from '../../src/domain/events/integration-event';
import { connectDatabase } from '../../src/infrastructure/persistence/database';
import { PostgresWalletRepository } from '../../src/infrastructure/persistence/repositories/postgres-wallet.repository';
import { PostgresWageringUnitOfWork } from '../../src/infrastructure/persistence/repositories/postgres-wagering-unit-of-work';
import { PostgresOutboxRepository } from '../../src/infrastructure/persistence/repositories/postgres-outbox.repository';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event.publisher';
import { OutboxMessageSchema } from '../../src/infrastructure/persistence/schemas/outbox-message.schema';
import { WalletSchema } from '../../src/infrastructure/persistence/schemas/wallet.schema';
import { WalletLedgerEntrySchema } from '../../src/infrastructure/persistence/schemas/wallet-ledger-entry.schema';
import { WagerTransactionSchema } from '../../src/infrastructure/persistence/schemas/wager-transaction.schema';
import { createTestDatabase } from '../support/postgres-test-database';
import { createTestQueue } from '../support/sqs-test-queue';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let queue: Awaited<ReturnType<typeof createTestQueue>>;
let openWallet: OpenWallet;
let submit: SubmitWager;
let outbox: PostgresOutboxRepository;
let publish: PublishOutbox;

beforeEach(async () => {
  database = await createTestDatabase();
  queue = await createTestQueue();
  openWallet = new OpenWallet(new PostgresWalletRepository(database.orm));
  submit = new SubmitWager(new PostgresWageringUnitOfWork(database.orm));
  outbox = new PostgresOutboxRepository(database.orm);
  publish = new PublishOutbox(outbox, queue.publisher);
}, 30000);

afterEach(async () => {
  try {
    if (queue) {
      await queue.close();
    }
  } finally {
    if (database) {
      await database.close();
    }
  }
});

async function createInput(amount = '100.00') {
  const wallet = await openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  };
}

async function createLoss() {
  const input = await createInput('0.00');
  return submit.execute(
    { ...input, kind: Kind.Loss, money: { amount: '0.00', currency: 'BRL' } },
    randomUUID(),
    { correlationId: 'outbox-test', causationId: 'command-test' },
  );
}

async function eventsFor(transactionId: string) {
  const records = await database.orm.em.fork().find(OutboxMessageSchema, {});
  return records.filter(
    ({ payload }) =>
      'transactionId' in payload.data &&
      payload.data.transactionId === transactionId,
  );
}

describe('Transactional outbox with PostgreSQL and LocalStack SQS', () => {
  test('opening emits processed and balance events; zero opening emits none', async () => {
    await createInput('0.00');
    expect(await database.orm.em.fork().count(OutboxMessageSchema)).toBe(0);
    const input = await createInput();
    const records = await database.orm.em
      .fork()
      .find(OutboxMessageSchema, { aggregateId: input.walletId });
    expect(records.map((record) => record.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(
      records.find((record) => record.eventType === 'WalletBalanceChanged')
        ?.payload.data,
    ).toMatchObject({ walletVersion: 1, balanceAfter: { amount: '100.00' } });
  });

  test('replays do not create additional financial events', async () => {
    const input = await createInput();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        submit.execute(input, key, { correlationId: 'bet-correlation' }),
      ),
    );
    const result = results[0];
    if (!result) {
      throw new Error('Expected wager result');
    }
    const events = await eventsFor(result.transactionId);
    expect(events).toHaveLength(2);
    expect(
      events.every(
        (event) => event.payload.correlationId === 'bet-correlation',
      ),
    ).toBe(true);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });

  test('LOSS and rejection emit status events without balance events', async () => {
    const input = await createInput('0.00');
    const rejected = await submit.execute(input, randomUUID());
    const loss = await submit.execute(
      {
        ...input,
        externalTransactionId: randomUUID(),
        kind: Kind.Loss,
        money: { amount: '0.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    expect(
      (await eventsFor(rejected.transactionId)).map((event) => event.eventType),
    ).toEqual(['WagerTransactionRejected']);
    expect(
      (await eventsFor(loss.transactionId)).map((event) => event.eventType),
    ).toEqual(['WagerTransactionProcessed']);
  });

  test('pending retries do not repeat pending events; expiration emits a rejection', async () => {
    const input = await createInput();
    const pending = await submit.execute(
      {
        ...input,
        kind: Kind.Refund,
        referenceExternalTransactionId: 'missing',
      },
      randomUUID(),
      { correlationId: 'pending-correlation' },
    );
    const record = await database.orm.em
      .fork()
      .findOneOrFail(WagerTransactionSchema, { id: pending.transactionId });
    const retry = new RetryPendingReferences(
      new PostgresWageringUnitOfWork(database.orm),
    );
    await retry.execute(new Date(record.createdAt.getTime() + 1500));
    expect(await eventsFor(pending.transactionId)).toHaveLength(1);
    await retry.execute(new Date(record.createdAt.getTime() + 86400000));
    const events = await eventsFor(pending.transactionId);
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(
      events.every(
        (event) => event.payload.correlationId === 'pending-correlation',
      ),
    ).toBe(true);
    expect(
      events.find((event) => event.eventType === 'WagerTransactionRejected')
        ?.payload.data,
    ).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND' });
  });

  test('outbox failure rolls back the wager, debit, ledger and events', async () => {
    const input = await createInput();
    const key = randomUUID();
    await database.orm.em.execute(`
      create function fail_outbox_test() returns trigger language plpgsql as $$
      begin raise exception 'injected outbox failure'; end $$;
      create trigger fail_outbox_test before insert on outbox_messages for each row execute function fail_outbox_test();
    `);
    try {
      await rejects(submit.execute(input, key), /injected outbox failure/);
      expect(
        await database.orm.em
          .fork()
          .count(WagerTransactionSchema, { idempotencyKey: key }),
      ).toBe(0);
      const wallet = await database.orm.em
        .fork()
        .findOneOrFail(WalletSchema, { id: input.walletId });
      expect(wallet.balance).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(
        await database.orm.em
          .fork()
          .count(WalletLedgerEntrySchema, { walletId: wallet.id }),
      ).toBe(1);
      expect(await database.orm.em.fork().count(OutboxMessageSchema)).toBe(2);
    } finally {
      await database.orm.em.execute(
        'drop trigger fail_outbox_test on outbox_messages; drop function fail_outbox_test()',
      );
    }
    expect((await submit.execute(input, key)).balance.amount).toBe('90.00');
  });

  test('publishes a versioned envelope with stable identity to real SQS', async () => {
    const loss = await createLoss();
    expect(await publish.execute()).toEqual({ published: 1, retried: 0 });
    const messages = await queue.receiveAll(1);
    const records = await eventsFor(loss.transactionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(records[0]?.payload);
    expect(messages[0]).toMatchObject({
      eventType: 'WagerTransactionProcessed',
      version: 1,
      correlationId: 'outbox-test',
      causationId: 'command-test',
      data: { money: { amount: '0.00', currency: 'BRL' } },
    });
    expect(records[0]?.publishedAt).not.toBeNull();
    expect(await publish.execute()).toEqual({ published: 0, retried: 0 });
  });

  test('concurrent publishers skip locked messages and publish each row once', async () => {
    await createInput();
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowPublisher = {
      publish: async (event: EventEnvelope): Promise<void> => {
        entered?.();
        await gate;
        await queue.publisher.publish(event);
      },
    };
    const first = new PublishOutbox(outbox, slowPublisher).execute(
      new Date(),
      1,
    );
    try {
      await ready;
      expect((await publish.execute()).published).toBe(1);
    } finally {
      release?.();
    }
    expect((await first).published).toBe(1);
    expect(
      await database.orm.em
        .fork()
        .count(OutboxMessageSchema, { publishedAt: { $ne: null } }),
    ).toBe(2);
    const messages = await queue.receiveAll(2);
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((event) => event.eventId)).size).toBe(2);
  });

  test('broker error persists backoff and later retry succeeds', async () => {
    const loss = await createLoss();
    const missingUrl = queue.queueUrl.replace(
      /[^/]+$/,
      `missing-${randomUUID()}.fifo`,
    );
    const unavailable = new PublishOutbox(
      outbox,
      new SqsEventPublisher(queue.client, missingUrl),
    );
    const now = new Date();
    expect(await unavailable.execute(now)).toEqual({
      published: 0,
      retried: 1,
    });
    const record = (await eventsFor(loss.transactionId))[0];
    expect(record?.attempts).toBe(1);
    expect(record?.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);
    expect(record?.publishedAt).toBeNull();
    expect((await publish.execute(now)).published).toBe(0);
    expect(
      (await publish.execute(new Date(now.getTime() + 1000))).published,
    ).toBe(1);
    expect(await queue.receiveAll(1)).toHaveLength(1);
  });

  test('rollback after SQS acceptance allows safe resend of the same event ID', async () => {
    const loss = await createLoss();
    await rejects(
      outbox.withNextDue(new Date(), async (message) => {
        await queue.publisher.publish(message.payload);
        throw new Error('simulated failure after send before commit');
      }),
      /after send before commit/,
    );
    expect((await eventsFor(loss.transactionId))[0]?.publishedAt).toBeNull();
    expect((await publish.execute()).published).toBe(1);
    // FIFO deduplicates this immediate resend. Consumers still need durable eventId deduplication.
    expect(await queue.receiveAll(1)).toHaveLength(1);
  });

  test('a fresh publisher recovers committed events after reconnection', async () => {
    await createLoss();
    const restarted = await connectDatabase(database.url);
    try {
      const recovery = new PublishOutbox(
        new PostgresOutboxRepository(restarted),
        queue.publisher,
      );
      expect((await recovery.execute()).published).toBe(1);
    } finally {
      await restarted.close();
    }
    expect(await queue.receiveAll(1)).toHaveLength(1);
  });

  test('uncommitted outbox records are invisible to the publisher', async () => {
    const loss = await createLoss();
    await publish.execute();
    await queue.receiveAll(1);
    const source = (await eventsFor(loss.transactionId))[0];
    if (!source) {
      throw new Error('Expected outbox event');
    }
    await database.orm.em.fork().transactional(async (em) => {
      const id = randomUUID();
      em.create(OutboxMessageSchema, {
        ...source,
        id,
        payload: { ...source.payload, eventId: id },
        attempts: 0,
        publishedAt: null,
        nextAttemptAt: null,
      });
      await em.flush();
      expect(await publish.execute()).toEqual({ published: 0, retried: 0 });
      expect(await queue.receiveAll(1)).toHaveLength(0);
    });
    expect((await publish.execute()).published).toBe(1);
    expect(await queue.receiveAll(1)).toHaveLength(1);
  });

  test('envelope mutation and republishing a terminal row are blocked in SQL', async () => {
    const loss = await createLoss();
    const record = (await eventsFor(loss.transactionId))[0];
    if (!record) {
      throw new Error('Expected event');
    }
    await rejects(
      database.orm.em.execute(
        "update outbox_messages set payload = jsonb_set(payload, '{version}', '2') where id = ?",
        [record.id],
      ),
      /immutable/,
    );
    await publish.execute();
    await rejects(
      database.orm.em.execute(
        'update outbox_messages set published_at = null where id = ?',
        [record.id],
      ),
      /immutable/,
    );
  });

  test('scheduled publisher sends committed events automatically', async () => {
    await createLoss();
    const names = [
      'DATABASE_URL',
      'SQS_ENDPOINT',
      'SQS_EVENTS_QUEUE_URL',
      'OUTBOX_PUBLISHER_ENABLED',
      'REFERENCE_RECOVERY_ENABLED',
    ] as const;
    const previous = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    process.env.DATABASE_URL = database.url;
    process.env.SQS_ENDPOINT =
      process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4567';
    process.env.SQS_EVENTS_QUEUE_URL = queue.queueUrl;
    process.env.OUTBOX_PUBLISHER_ENABLED = 'true';
    process.env.REFERENCE_RECOVERY_ENABLED = 'false';
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
      await app.init();
      let published = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        published = await database.orm.em
          .fork()
          .count(OutboxMessageSchema, { publishedAt: { $ne: null } });
        if (published === 1) {
          break;
        }
        await Bun.sleep(50);
      }
      expect(published).toBe(1);
      expect(await queue.receiveAll(1)).toHaveLength(1);
    } finally {
      await app.close();
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  }, 15000);
  test('a new publisher process recovers events after SIGKILL before publication', async () => {
    const loss = await createLoss();
    const spawn = () => {
      const child = Bun.spawn(
        [process.execPath, 'tests/support/outbox-publisher-process.ts'],
        {
          env: {
            ...process.env,
            WAGER_TEST_DATABASE_URL: database.url,
            TEST_EVENTS_QUEUE_URL: queue.queueUrl,
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      return { child, reader: child.stdout.getReader() };
    };
    const killed = spawn();
    let restarted: ReturnType<typeof spawn> | undefined;
    try {
      expect(new TextDecoder().decode((await killed.reader.read()).value)).toBe(
        'READY\n',
      );
      killed.child.kill('SIGKILL');
      await killed.child.exited;
      expect((await eventsFor(loss.transactionId))[0]?.publishedAt).toBeNull();
      expect(await queue.receiveAll(1)).toHaveLength(0);
      restarted = spawn();
      expect(
        new TextDecoder().decode((await restarted.reader.read()).value),
      ).toBe('READY\n');
      await restarted.child.stdin.end();
      let output = '';
      while (true) {
        const chunk = await restarted.reader.read();
        if (chunk.done) {
          break;
        }
        output += new TextDecoder().decode(chunk.value);
      }
      expect(await restarted.child.exited).toBe(0);
      expect(output).toContain('PUBLISHED:1');
      expect(await queue.receiveAll(1)).toHaveLength(1);
      expect(
        (await eventsFor(loss.transactionId))[0]?.publishedAt,
      ).not.toBeNull();
    } finally {
      for (const process of [killed.child, restarted?.child]) {
        if (process && process.exitCode === null) {
          process.kill('SIGKILL');
        }
      }
      await killed.child.exited;
      if (restarted) {
        await restarted.child.exited;
      }
    }
  }, 15000);
});
