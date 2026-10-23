import { RetryPendingReferences } from '../../src/application/wagering/retry-pending-references';
import { PublishOutbox } from '../../src/application/events/publish-outbox';
import { PostgresOutboxRepository } from '../../src/infrastructure/persistence/repositories/postgres-outbox.repository';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { rejects } from 'node:assert/strict';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  SendMessageCommand,
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import { SubmitWager } from '../../src/application/wagering/submit-wager';
import {
  WagerTransactionStatus,
  WagerTransactionKind,
} from '../../src/domain/entities/wager-transaction';
import { PostgresWalletRepository } from '../../src/infrastructure/persistence/repositories/postgres-wallet.repository';
import { PostgresWageringUnitOfWork } from '../../src/infrastructure/persistence/repositories/postgres-wagering-unit-of-work';
import { InboxMessageSchema } from '../../src/infrastructure/persistence/schemas/inbox-message.schema';
import { WalletSchema } from '../../src/infrastructure/persistence/schemas/wallet.schema';
import { WagerTransactionSchema } from '../../src/infrastructure/persistence/schemas/wager-transaction.schema';
import { OutboxMessageSchema } from '../../src/infrastructure/persistence/schemas/outbox-message.schema';
import { WalletLedgerEntrySchema } from '../../src/infrastructure/persistence/schemas/wallet-ledger-entry.schema';
import { WagerQueueConsumer } from '../../src/infrastructure/messaging/wager-queue.consumer';
import { createTestDatabase } from '../support/postgres-test-database';
import { createTestQueue } from '../support/sqs-test-queue';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let queue: Awaited<ReturnType<typeof createTestQueue>>;
let dlq: Awaited<ReturnType<typeof createTestQueue>>;
let submit: SubmitWager;
let consumer: WagerQueueConsumer;

beforeEach(async () => {
  database = await createTestDatabase();
  queue = await createTestQueue();
  dlq = await createTestQueue();
  const attributes = await dlq.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.queueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  await queue.client.send(
    new SetQueueAttributesCommand({
      QueueUrl: queue.queueUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attributes.Attributes?.QueueArn,
          maxReceiveCount: '5',
        }),
      },
    }),
  );
  submit = new SubmitWager(new PostgresWageringUnitOfWork(database.orm));
  consumer = new WagerQueueConsumer(
    queue.client,
    queue.queueUrl,
    dlq.queueUrl,
    submit,
    { waitTimeSeconds: 0, visibilitySeconds: 1 },
  );
}, 30000);

afterEach(async () => {
  await queue?.close();
  await dlq?.close();
  await database?.close();
});

async function envelope(amount = '10.00') {
  const wallet = await new OpenWallet(
    new PostgresWalletRepository(database.orm),
  ).execute({
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  return {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind: WagerTransactionKind.Bet,
      money: { amount, currency: 'BRL' },
    },
  };
}

async function send(body: unknown) {
  await queue.client.send(
    new SendMessageCommand({
      QueueUrl: queue.queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: randomUUID(),
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function assertFinancialState(
  walletId: string,
  balance: string,
  inboxes: number,
  entries: number,
) {
  const em = database.orm.em.fork();
  expect((await em.findOneOrFail(WalletSchema, { id: walletId })).balance).toBe(
    balance,
  );
  expect(await em.count(InboxMessageSchema)).toBe(inboxes);
  expect(await em.count(WalletLedgerEntrySchema, { walletId })).toBe(entries);
  const sums = await em.execute<{ balance: string }[]>(
    `select sum(case when direction = 'CREDIT' then amount else -amount end)::text as balance
     from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  expect(sums[0]?.balance).toBe(balance);
}

async function deadLetter() {
  const response = await dlq.client.send(
    new ReceiveMessageCommand({
      QueueUrl: dlq.queueUrl,
      WaitTimeSeconds: 0,
      MessageAttributeNames: ['All'],
    }),
  );
  return response.Messages?.[0];
}

async function nextDelivery(target = consumer) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await target.processNext();
    if (result.outcome !== 'EMPTY') {
      return result;
    }
    await Bun.sleep(100);
  }
  throw new Error('Delivery did not become visible within the test deadline');
}

function childConsumer(pause = false) {
  const child = Bun.spawn(
    [process.execPath, 'tests/support/consume-wager-process.ts'],
    {
      env: {
        ...process.env,
        WAGER_TEST_DATABASE_URL: database.url,
        TEST_INPUT_QUEUE_URL: queue.queueUrl,
        TEST_DLQ_URL: dlq.queueUrl,
        PAUSE_AFTER_COMMIT: String(pause),
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const reader = child.stdout.getReader();
  let text = '';
  async function waitFor(marker: string) {
    while (!text.includes(marker)) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`Child exited before ${marker}: ${text}`);
      }
      text += new TextDecoder().decode(chunk.value);
    }
    text = text.slice(text.indexOf(marker) + marker.length);
  }
  return { child, waitFor };
}

describe('Persistent inbox and real SQS consumption', () => {
  test('50 concurrent broker deliveries debit once and atomically record one inbox', async () => {
    const message = await envelope();
    await Promise.all(Array.from({ length: 50 }, () => send(message)));
    const results = await Promise.all(
      Array.from({ length: 50 }, () => consumer.processNext()),
    );
    expect(results.every((result) => result.outcome === 'ACKNOWLEDGED')).toBe(
      true,
    );
    await assertFinancialState(message.data.walletId, '90.00', 1, 2);
    expect(await database.orm.em.fork().count(OutboxMessageSchema)).toBe(4);
    expect(await consumer.processNext()).toEqual({ outcome: 'EMPTY' });
  }, 20000);

  test('HTTP replay through the queue still records an inbox without new effects', async () => {
    const message = await envelope();
    const { idempotencyKey, ...input } = message.data;
    const original = await submit.execute(input, idempotencyKey);
    await send(message);
    expect(await consumer.processNext()).toMatchObject({
      outcome: 'ACKNOWLEDGED',
      transactionId: original.transactionId,
    });
    await send({ ...message, messageId: randomUUID() });
    expect((await consumer.processNext()).outcome).toBe('ACKNOWLEDGED');
    await assertFinancialState(input.walletId, '90.00', 2, 2);
    expect(await database.orm.em.fork().count(OutboxMessageSchema)).toBe(4);
  });

  test('divergent payload under the same message identity is dead lettered', async () => {
    const message = await envelope();
    await send(message);
    await consumer.processNext();
    const divergent = {
      ...message,
      data: { ...message.data, money: { amount: '20.00', currency: 'BRL' } },
    };
    await send(divergent);
    expect(await consumer.processNext()).toMatchObject({
      outcome: 'DEAD_LETTERED',
      code: 'INBOX_MESSAGE_CONFLICT',
    });
    const dead = await deadLetter();
    expect(JSON.parse(dead?.Body ?? '{}')).toEqual(divergent);
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe(
      'INBOX_MESSAGE_CONFLICT',
    );
    await assertFinancialState(message.data.walletId, '90.00', 1, 2);
  });

  test('business rejection is committed and acknowledged without a debit', async () => {
    const message = await envelope('150.00');
    await send(message);
    expect((await consumer.processNext()).outcome).toBe('ACKNOWLEDGED');
    await assertFinancialState(message.data.walletId, '100.00', 1, 1);
    expect(await deadLetter()).toBeUndefined();
    expect(
      (
        await database.orm.em.fork().findOneOrFail(WagerTransactionSchema, {
          idempotencyKey: message.data.idempotencyKey,
        })
      ).status,
    ).toBe(WagerTransactionStatus.Rejected);
  });

  test('malformed payload is dead lettered without creating an inbox', async () => {
    await send('{invalid-json');
    expect(await consumer.processNext()).toMatchObject({
      outcome: 'DEAD_LETTERED',
      code: 'INVALID_QUEUE_MESSAGE',
    });
    expect((await deadLetter())?.Body).toBe('{invalid-json');
    expect(await database.orm.em.fork().count(InboxMessageSchema)).toBe(0);
  });

  test('transient failure rolls back inbox, wallet, ledger and outbox before retry', async () => {
    const message = await envelope();
    await database.orm.em.execute(`
      create function fail_inbox_test() returns trigger language plpgsql as $$
      begin raise exception 'injected transient failure' using errcode = '40001'; end $$;
      create trigger fail_inbox_test before insert on outbox_messages
        for each row execute function fail_inbox_test();
    `);
    await send(message);
    expect(await consumer.processNext()).toMatchObject({
      outcome: 'RETRY',
      attempts: 1,
      delay: 1,
    });
    await assertFinancialState(message.data.walletId, '100.00', 0, 1);
    expect(await database.orm.em.fork().count(OutboxMessageSchema)).toBe(2);
    await database.orm.em.execute(
      'drop trigger fail_inbox_test on outbox_messages; drop function fail_inbox_test()',
    );
    await Bun.sleep(1100);
    expect((await nextDelivery()).outcome).toBe('ACKNOWLEDGED');
    await assertFinancialState(message.data.walletId, '90.00', 1, 2);
  });

  test('transient errors exhaust the bounded attempts and preserve original body in DLQ', async () => {
    const message = await envelope();
    await database.orm.em.execute(`
      create function fail_inbox_test() returns trigger language plpgsql as $$
      begin raise exception 'injected transient failure' using errcode = '40001'; end $$;
      create trigger fail_inbox_test before insert on outbox_messages
        for each row execute function fail_inbox_test();
    `);
    const bounded = new WagerQueueConsumer(
      queue.client,
      queue.queueUrl,
      dlq.queueUrl,
      submit,
      { waitTimeSeconds: 0, maxAttempts: 2 },
    );
    await send(message);
    expect((await bounded.processNext()).outcome).toBe('RETRY');
    await Bun.sleep(1100);
    expect(await nextDelivery(bounded)).toMatchObject({
      outcome: 'DEAD_LETTERED',
      attempts: 2,
    });
    expect(JSON.parse((await deadLetter())?.Body ?? '{}')).toEqual(message);
    await assertFinancialState(message.data.walletId, '100.00', 0, 1);
  });

  test('SQL prevents changing inbox identity or reopening a processed delivery', async () => {
    const message = await envelope();
    await send(message);
    await consumer.processNext();
    await rejects(
      database.orm.em.execute('update inbox_messages set processed_at = null'),
      /immutable/,
    );
    await rejects(
      database.orm.em.execute(
        "update inbox_messages set payload_hash = repeat('b', 64)",
      ),
      /immutable/,
    );
  });
  test('three independent consumer processes acknowledge 50 duplicates with one debit', async () => {
    const message = await envelope();
    const children = [17, 17, 16].map((count) => ({
      ...childConsumer(),
      count,
    }));
    try {
      await Promise.all(children.map((child) => child.waitFor('READY')));
      await Promise.all(Array.from({ length: 50 }, () => send(message)));
      for (const { child, count } of children) {
        await child.stdin.write(String(count));
        await child.stdin.end();
      }
      await Promise.all(
        children.map(async ({ child, count, waitFor }) => {
          await waitFor(`CONSUMED:${count}`);
          expect(await child.exited).toBe(0);
        }),
      );
      await assertFinancialState(message.data.walletId, '90.00', 1, 2);
      expect(await database.orm.em.fork().count(OutboxMessageSchema)).toBe(4);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }
      await Promise.all(children.map(({ child }) => child.exited));
    }
  }, 30000);

  test('SIGKILL after commit before ack is recovered by a fresh consumer without repeating events', async () => {
    const message = await envelope();
    await send(message);
    const { child, waitFor } = childConsumer(true);
    try {
      await waitFor('READY');
      await waitFor('COMMITTED');
      child.kill('SIGKILL');
      await child.exited;
      await assertFinancialState(message.data.walletId, '90.00', 1, 2);
      expect((await nextDelivery()).outcome).toBe('ACKNOWLEDGED');
      await assertFinancialState(message.data.walletId, '90.00', 1, 2);
      expect(await database.orm.em.fork().count(OutboxMessageSchema)).toBe(4);
      expect((await consumer.processNext()).outcome).toBe('EMPTY');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      await child.exited;
    }
  }, 15000);
  test('DLQ transport failure keeps the original message available for redelivery', async () => {
    await send('{invalid');
    const missing = dlq.queueUrl.replace(/[^/]+$/, 'missing.fifo');
    const unavailable = new WagerQueueConsumer(
      queue.client,
      queue.queueUrl,
      missing,
      submit,
      { waitTimeSeconds: 0, visibilitySeconds: 1 },
    );
    await rejects(unavailable.processNext());
    expect((await nextDelivery()).outcome).toBe('DEAD_LETTERED');
    expect((await deadLetter())?.Body).toBe('{invalid');
  }, 15000);

  test('SIGTERM waits for an in-flight commit and ack before closing clients', async () => {
    const message = await envelope();
    await send(message);
    const child = Bun.spawn(
      [process.execPath, 'tests/support/wager-worker-process.ts'],
      {
        env: {
          ...process.env,
          DATABASE_URL: database.url,
          SQS_ENDPOINT:
            process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4567',
          SQS_TRANSACTIONS_QUEUE_URL: queue.queueUrl,
          SQS_TRANSACTIONS_DLQ_URL: dlq.queueUrl,
          SQS_CONSUMER_ENABLED: 'true',
          REFERENCE_RECOVERY_ENABLED: 'false',
          OUTBOX_PUBLISHER_ENABLED: 'false',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const reader = child.stdout.getReader();
    let output = '';
    try {
      while (!output.includes('RECEIVED')) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error('Worker exited before receiving');
        }
        output += new TextDecoder().decode(chunk.value);
      }
      child.kill('SIGTERM');
      await Bun.sleep(100);
      expect(child.exitCode).toBeNull();
      await child.stdin.end();
      const code = await child.exited;
      expect([0, 143]).toContain(code);
      await assertFinancialState(message.data.walletId, '90.00', 1, 2);
      expect((await consumer.processNext()).outcome).toBe('EMPTY');
      expect(await database.orm.em.fork().count(OutboxMessageSchema)).toBe(4);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      await child.exited;
    }
  }, 15000);
  test('permanent failure before acceptance goes to DLQ without inventing a FAILED transaction', async () => {
    const message = await envelope();
    await database.orm.em.execute(`
      create function fail_initial_integrity() returns trigger language plpgsql as $$
      begin raise exception 'injected integrity failure' using errcode = '23514'; end $$;
      create trigger fail_initial_integrity before insert on wallet_ledger_entries for each row execute function fail_initial_integrity();
    `);
    await send(message);
    expect(await consumer.processNext()).toMatchObject({
      outcome: 'DEAD_LETTERED',
      code: 'PERSISTENCE_INTEGRITY_FAILURE',
    });
    expect(
      (await deadLetter())?.MessageAttributes?.failureCode?.StringValue,
    ).toBe('PERSISTENCE_INTEGRITY_FAILURE');
    expect(
      await database.orm.em.fork().count(WagerTransactionSchema, {
        idempotencyKey: message.data.idempotencyKey,
      }),
    ).toBe(0);
    await assertFinancialState(message.data.walletId, '100.00', 0, 1);
  });

  test('an accepted SQS reversal can fail permanently, publish its audit event and safely replay', async () => {
    const bet = await envelope();
    const reversal = {
      ...bet,
      messageId: randomUUID(),
      correlationId: 'failed-sqs',
      data: {
        ...bet.data,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.data.externalTransactionId,
      },
    };
    await send(reversal);
    expect((await consumer.processNext()).outcome).toBe('ACKNOWLEDGED');
    await send(bet);
    expect((await consumer.processNext()).outcome).toBe('ACKNOWLEDGED');
    const pending = await database.orm.em
      .fork()
      .findOneOrFail(WagerTransactionSchema, {
        idempotencyKey: reversal.data.idempotencyKey,
      });
    await database.orm.em.execute(`
      create function fail_sqs_recovery() returns trigger language plpgsql as $$
      begin raise exception 'injected recovery integrity failure' using errcode = '23514'; end $$;
      create trigger fail_sqs_recovery before insert on wallet_ledger_entries for each row execute function fail_sqs_recovery();
    `);
    await new RetryPendingReferences(
      new PostgresWageringUnitOfWork(database.orm),
    ).execute(new Date(pending.createdAt.getTime() + 2000));
    expect(
      (
        await database.orm.em
          .fork()
          .findOneOrFail(WagerTransactionSchema, { id: pending.id })
      ).status,
    ).toBe(WagerTransactionStatus.Failed);
    await send(reversal);
    expect((await consumer.processNext()).outcome).toBe('ACKNOWLEDGED');
    await assertFinancialState(bet.data.walletId, '90.00', 2, 2);
    const events = await createTestQueue();
    try {
      expect(
        (
          await new PublishOutbox(
            new PostgresOutboxRepository(database.orm),
            events.publisher,
          ).execute()
        ).published,
      ).toBe(6);
      const published = await events.receiveAll(6);
      expect(
        published.filter(
          (event) => event.eventType === 'WagerTransactionFailed',
        ),
      ).toHaveLength(1);
      expect(
        published.find((event) => event.eventType === 'WagerTransactionFailed'),
      ).toMatchObject({
        correlationId: 'failed-sqs',
        causationId: reversal.messageId,
        data: {
          transactionId: pending.id,
          failureCode: 'PERSISTENCE_INTEGRITY_FAILURE',
        },
      });
      expect(await deadLetter()).toBeUndefined();
    } finally {
      await events.close();
    }
  });
});
