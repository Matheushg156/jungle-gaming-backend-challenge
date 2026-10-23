import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import {
  SendMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { createTestDatabase } from './postgres-test-database';
import { createTestQueue } from './sqs-test-queue';

async function run() {
  const database = await createTestDatabase();
  const queues = await Promise.all([
    createTestQueue(),
    createTestQueue(),
    createTestQueue(),
  ]);
  const source = queues[0];
  const events = queues[2];
  const server = Bun.spawn([process.execPath, 'dist/main.js'], {
    env: {
      ...process.env,
      DATABASE_URL: database.url,
      PORT: '3107',
      SQS_ENDPOINT: process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4567',
      SQS_TRANSACTIONS_QUEUE_URL: source.queueUrl,
      SQS_TRANSACTIONS_DLQ_URL: queues[1].queueUrl,
      SQS_EVENTS_QUEUE_URL: events.queueUrl,
      SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      REFERENCE_RECOVERY_ENABLED: 'true',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(server.stdout).text();
  const stderr = new Response(server.stderr).text();
  const base = 'http://127.0.0.1:3107';
  async function waitUntil(check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (await check()) {
          return;
        }
      } catch {
        /* startup/async worker may still be pending */
      }
      await Bun.sleep(100);
    }
    throw new Error('Compiled app smoke deadline exceeded');
  }
  try {
    await waitUntil(
      async () => (await fetch(`${base}/health/ready`)).status === 200,
    );
    const playerId = randomUUID();
    const response = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    assert.equal(response.status, 201);
    const wallet = (await response.json()) as { id: string };
    const input = {
      providerId: 'smoke-provider',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      gameId: 'game',
      roundId: 'round',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const key = randomUUID();
    const post = () =>
      fetch(`${base}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(input),
      });
    assert.equal((await post()).status, 200);
    assert.equal(
      ((await (await post()).json()) as { idempotentReplay: boolean })
        .idempotentReplay,
      true,
    );
    const externalId = randomUUID();
    await source.client.send(
      new SendMessageCommand({
        QueueUrl: source.queueUrl,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: randomUUID(),
        MessageBody: JSON.stringify({
          messageId: randomUUID(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            ...input,
            externalTransactionId: externalId,
            idempotencyKey: randomUUID(),
            kind: 'LOSS',
            money: { amount: '0.00', currency: 'BRL' },
          },
        }),
      }),
    );
    await waitUntil(
      async () =>
        (
          await fetch(
            `${base}/providers/smoke-provider/wagering/transactions/${externalId}`,
          )
        ).status === 200,
    );
    await waitUntil(
      async () =>
        (
          await events.client.send(
            new GetQueueAttributesCommand({
              QueueUrl: events.queueUrl,
              AttributeNames: ['ApproximateNumberOfMessages'],
            }),
          )
        ).Attributes?.ApproximateNumberOfMessages === '5',
    );
    assert.equal((await events.receiveAll(5)).length, 5);
    const reconciliation = await fetch(
      `${base}/wallets/${wallet.id}/reconciliation`,
      { method: 'POST' },
    );
    assert.equal(reconciliation.status, 200);
    const reconciled = (await reconciliation.json()) as {
      consistent: boolean;
      storedBalance: object;
    };
    assert.equal(reconciled.consistent, true);
    assert.deepEqual(reconciled.storedBalance, {
      amount: '75.00',
      currency: 'BRL',
    });
    assert.ok(
      (await (await fetch(`${base}/metrics`)).text()).includes(
        'wager_duplicates_total 1',
      ),
    );
  } finally {
    server.kill('SIGTERM');
    const code = await server.exited;
    const logs = await stdout;
    const errors = await stderr;
    await Promise.all(queues.map((queue) => queue.close()));
    await database.close();
    assert.ok(
      [0, 143].includes(code),
      `Unexpected app exit code ${code}: ${errors}`,
    );
    for (const line of logs.trim().split('\n')) {
      const log = JSON.parse(line) as Record<string, unknown>;
      assert.ok(
        typeof log.level === 'string' && typeof log.timestamp === 'string',
        'All runtime logs must have a JSON level and timestamp',
      );
      assert.ok(
        !('money' in log) && !('balance' in log) && !('amount' in log),
        'Logs must not include monetary payloads',
      );
    }
  }
  console.log(
    'Compiled app smoke passed: HTTP, SQS consumer, publisher, reconciliation, metrics, JSON logs and SIGTERM',
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
