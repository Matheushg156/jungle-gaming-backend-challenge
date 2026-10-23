import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  GetQueueAttributesCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/entities/wager-transaction';
import { PostgresWalletRepository } from '../../src/infrastructure/persistence/repositories/postgres-wallet.repository';
import { WagerTransactionSchema } from '../../src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WalletLedgerEntrySchema } from '../../src/infrastructure/persistence/schemas/wallet-ledger-entry.schema';
import { WalletSchema } from '../../src/infrastructure/persistence/schemas/wallet.schema';
import { InboxMessageSchema } from '../../src/infrastructure/persistence/schemas/inbox-message.schema';
import { OutboxMessageSchema } from '../../src/infrastructure/persistence/schemas/outbox-message.schema';
import { connectDatabase } from '../../src/infrastructure/persistence/database';
import { createTestDatabase } from '../support/postgres-test-database';
import { createTestQueue } from '../support/sqs-test-queue';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let queues: Awaited<ReturnType<typeof createTestQueue>>[];
beforeEach(async () => {
  database = await createTestDatabase();
  queues = await Promise.all([
    createTestQueue(),
    createTestQueue(),
    createTestQueue(),
  ]);
}, 30000);
afterEach(async () => {
  await Promise.all(queues.map((queue) => queue.close()));
  await database.close();
});

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error('SQS reversal restart deadline exceeded');
}
function worker(recover: boolean) {
  const process = Bun.spawn(
    [globalThis.process.execPath, 'tests/support/recovery-worker-process.ts'],
    {
      env: {
        ...globalThis.process.env,
        DATABASE_URL: database.url,
        SQS_ENDPOINT:
          globalThis.process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4567',
        SQS_TRANSACTIONS_QUEUE_URL: queues[0]!.queueUrl,
        SQS_TRANSACTIONS_DLQ_URL: queues[1]!.queueUrl,
        SQS_EVENTS_QUEUE_URL: queues[2]!.queueUrl,
        SQS_CONSUMER_ENABLED: 'true',
        SQS_VISIBILITY_TIMEOUT_SECONDS: '1',
        REFERENCE_RECOVERY_ENABLED: String(recover),
        OUTBOX_PUBLISHER_ENABLED: String(recover),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  // Drain logs immediately so the subprocess cannot block on a full pipe.
  let output = '';
  const drained = (async () => {
    for await (const chunk of process.stdout) {
      output += new TextDecoder().decode(chunk);
    }
  })();
  const errors = new Response(process.stderr).text();
  return {
    process,
    drained,
    errors,
    ready: () =>
      waitFor(async () => {
        if (process.exitCode !== null) {
          throw new Error(`Worker exited: ${await errors}`);
        }
        return output.includes('READY\n');
      }),
  };
}
async function queueEmpty() {
  const queue = queues[0]!;
  const response = await queue.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queue.queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }),
  );
  return (
    response.Attributes?.ApproximateNumberOfMessages === '0' &&
    response.Attributes?.ApproximateNumberOfMessagesNotVisible === '0'
  );
}
async function send(body: unknown, group: string) {
  const queue = queues[0]!;
  await queue.client.send(
    new SendMessageCommand({
      QueueUrl: queue.queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: group,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

test.each([Kind.Refund, Kind.Rollback])(
  '%s before its BET survives process death and resolves once after restart',
  async (kind) => {
    const wallet = await new OpenWallet(
      new PostgresWalletRepository(database.orm),
    ).execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const bet = {
      providerId: 'restart-provider',
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind: Kind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };
    const reversal = {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      correlationId: 'restart-correlation',
      data: {
        ...bet,
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        kind,
        referenceExternalTransactionId: bet.externalTransactionId,
      },
    };
    const first = worker(false);
    let second: ReturnType<typeof worker> | undefined;
    try {
      await first.ready();
      await send(reversal, wallet.id);
      await waitFor(
        async () =>
          (await database.orm.em.fork().count(WagerTransactionSchema, {
            idempotencyKey: reversal.data.idempotencyKey,
            status: Status.PendingReference,
          })) === 1 && (await queueEmpty()),
      );
      expect(
        await database.orm.em
          .fork()
          .count(InboxMessageSchema, { processedAt: { $ne: null } }),
      ).toBe(1);
      first.process.kill('SIGKILL');
      await first.process.exited;
      expect(
        await database.orm.em
          .fork()
          .count(OutboxMessageSchema, { publishedAt: null }),
      ).toBe(3);
      await send(
        {
          messageId: randomUUID(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: bet,
        },
        wallet.id,
      );
      second = worker(true);
      await second.ready();
      await waitFor(
        async () =>
          (await database.orm.em.fork().count(WagerTransactionSchema, {
            idempotencyKey: reversal.data.idempotencyKey,
            status: Status.Processed,
          })) === 1,
      );
      // A new broker delivery of the original application message must only replay.
      await send(reversal, randomUUID());
      await waitFor(queueEmpty);
      await waitFor(
        async () =>
          (await database.orm.em
            .fork()
            .count(OutboxMessageSchema, { publishedAt: { $ne: null } })) === 7,
      );
      expect(await database.orm.em.fork().count(InboxMessageSchema)).toBe(2);
      expect(
        await database.orm.em
          .fork()
          .count(WalletLedgerEntrySchema, { walletId: wallet.id }),
      ).toBe(3);
      expect(
        await database.orm.em
          .fork()
          .count(WagerTransactionSchema, { walletId: wallet.id }),
      ).toBe(3);
      const events = await queues[2]!.receiveAll(7);
      expect(events).toHaveLength(7);
      expect(new Set(events.map((event) => event.eventId)).size).toBe(7);
      expect(
        events.filter(
          (event) => event.eventType === 'WagerTransactionPendingReference',
        ),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.eventType === 'WalletBalanceChanged'),
      ).toHaveLength(3);
      expect(
        events.filter((event) => event.correlationId === 'restart-correlation'),
      ).toHaveLength(3);
      second.process.kill('SIGTERM');
      expect([0, 143]).toContain(await second.process.exited);
      const restarted = await connectDatabase(database.url);
      try {
        const current = await restarted.em
          .fork()
          .findOneOrFail(WalletSchema, { id: wallet.id });
        expect(current.balance).toBe('100.00');
        expect(current.version).toBe(3);
        const rows = await restarted.em.execute<{ balance: string }[]>(
          `select sum(case direction when 'CREDIT' then amount else -amount end)::numeric(18,2)::text as balance
         from wallet_ledger_entries where wallet_id = ?`,
          [wallet.id],
        );
        expect(rows[0]?.balance).toBe(current.balance);
      } finally {
        await restarted.close(true);
      }
    } finally {
      for (const child of [first, second]) {
        if (child) {
          if (child.process.exitCode === null) {
            child.process.kill('SIGKILL');
          }
          await child.process.exited;
          await child.drained;
        }
      }
    }
  },
  30000,
);
