import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import { SubmitWager } from '../../src/application/wagering/submit-wager';
import { RetryPendingReferences } from '../../src/application/wagering/retry-pending-references';
import type { SubmitWagerInput } from '../../src/application/wagering/wager.contracts';
import type {
  LedgerPage,
  ReconciliationResult,
} from '../../src/application/queries/query.contracts';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/entities/wager-transaction';
import { PostgresWalletRepository } from '../../src/infrastructure/persistence/repositories/postgres-wallet.repository';
import { PostgresWageringUnitOfWork } from '../../src/infrastructure/persistence/repositories/postgres-wagering-unit-of-work';
import { WagerTransactionSchema } from '../../src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WalletSchema } from '../../src/infrastructure/persistence/schemas/wallet.schema';
import { createTestDatabase } from '../support/postgres-test-database';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let openWallet: OpenWallet;
let submit: SubmitWager;
let app: INestApplication;
let baseUrl: string;
const previousUrl = process.env.DATABASE_URL;
const previousRecovery = process.env.REFERENCE_RECOVERY_ENABLED;

const previousOutboxSetting = process.env.OUTBOX_PUBLISHER_ENABLED;
beforeAll(async () => {
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  database = await createTestDatabase();
  openWallet = new OpenWallet(new PostgresWalletRepository(database.orm));
  submit = new SubmitWager(new PostgresWageringUnitOfWork(database.orm));
  process.env.DATABASE_URL = database.url;
  process.env.REFERENCE_RECOVERY_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 30000);

afterAll(async () => {
  if (previousOutboxSetting === undefined) {
    delete process.env.OUTBOX_PUBLISHER_ENABLED;
  } else {
    process.env.OUTBOX_PUBLISHER_ENABLED = previousOutboxSetting;
  }
  try {
    if (app) {
      await app.close();
    }
  } finally {
    if (previousUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousUrl;
    }
    if (previousRecovery === undefined) {
      delete process.env.REFERENCE_RECOVERY_ENABLED;
    } else {
      process.env.REFERENCE_RECOVERY_ENABLED = previousRecovery;
    }
    if (database) {
      await database.close();
    }
  }
});

async function createInput(): Promise<SubmitWagerInput> {
  const wallet = await openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  };
}

async function getPage(walletId: string, query = ''): Promise<LedgerPage> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}/ledger${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as LedgerPage;
}

async function reconcile(walletId: string): Promise<ReconciliationResult> {
  const response = await fetch(
    `${baseUrl}/wallets/${walletId}/reconciliation`,
    { method: 'POST' },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as ReconciliationResult;
}

async function getMismatchCount(): Promise<number> {
  const response = await fetch(`${baseUrl}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  const output = await response.text();
  const match = /^wallet_reconciliation_mismatches_total (\d+)$/m.exec(output);
  expect(match).not.toBeNull();
  return Number(match?.[1]);
}

describe('Read endpoints and reconciliation with real PostgreSQL', () => {
  test('transaction lookup by internal and provider identifiers returns the same snapshot', async () => {
    const input = await createInput();
    const result = await submit.execute(input, randomUUID());
    await submit.execute(
      { ...input, externalTransactionId: randomUUID() },
      randomUUID(),
    );
    const internal = await fetch(
      `${baseUrl}/wagering/transactions/${result.transactionId}`,
    );
    const external = await fetch(
      `${baseUrl}/providers/${input.providerId}/wagering/transactions/${input.externalTransactionId}`,
    );
    expect(internal.status).toBe(200);
    expect(external.status).toBe(200);
    const body: unknown = await internal.json();
    expect(body).toEqual(await external.json());
    expect(body).toMatchObject({
      transactionId: result.transactionId,
      money: input.money,
      status: Status.Processed,
      result: { balance: { amount: '90.00' } },
    });
    expect(body).not.toHaveProperty('payloadHash');
    expect(body).not.toHaveProperty('idempotencyKey');
  });

  test('transaction lookup is scoped by provider', async () => {
    const input = await createInput();
    const first = await submit.execute(input, randomUUID());
    const second = await submit.execute(
      { ...input, providerId: 'provider-b' },
      randomUUID(),
    );
    const response = await fetch(
      `${baseUrl}/providers/provider-b/wagering/transactions/${input.externalTransactionId}`,
    );
    expect(await response.json()).toMatchObject({
      transactionId: second.transactionId,
    });
    expect(second.transactionId).not.toBe(first.transactionId);
  });

  test('lookup exposes pending, rejected and recovered transaction states', async () => {
    const input = await createInput();
    const pending = await submit.execute(
      {
        ...input,
        kind: Kind.Refund,
        externalTransactionId: randomUUID(),
        referenceExternalTransactionId: input.externalTransactionId,
      },
      randomUUID(),
    );
    const pendingResponse = await fetch(
      `${baseUrl}/wagering/transactions/${pending.transactionId}`,
    );
    expect(await pendingResponse.json()).toMatchObject({
      status: Status.PendingReference,
    });
    await submit.execute(input, randomUUID());
    const record = await database.orm.em
      .fork()
      .findOneOrFail(WagerTransactionSchema, { id: pending.transactionId });
    await new RetryPendingReferences(
      new PostgresWageringUnitOfWork(database.orm),
    ).execute(new Date(record.createdAt.getTime() + 1500));
    const recovered = await fetch(
      `${baseUrl}/wagering/transactions/${pending.transactionId}`,
    );
    expect(await recovered.json()).toMatchObject({
      status: Status.Processed,
      result: { balance: { amount: '100.00' } },
    });
    const rejected = await submit.execute(
      {
        ...input,
        externalTransactionId: randomUUID(),
        money: { amount: '999.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    const rejection = await fetch(
      `${baseUrl}/wagering/transactions/${rejected.transactionId}`,
    );
    expect(await rejection.json()).toMatchObject({
      status: Status.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  test('ledger pages have stable order, no duplicates and exclude later movements', async () => {
    const input = await createInput();
    const first = await submit.execute(input, randomUUID());
    const second = await submit.execute(
      { ...input, externalTransactionId: randomUUID() },
      randomUUID(),
    );
    const page = await getPage(input.walletId, '?limit=1');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.money).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(page.nextCursor).not.toBeNull();
    const later = await submit.execute(
      { ...input, externalTransactionId: randomUUID() },
      randomUUID(),
    );
    const items = [...page.items];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await getPage(
        input.walletId,
        `?limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      items.push(...next.items);
      cursor = next.nextCursor;
    }
    expect(items).toHaveLength(3);
    expect(new Set(items.map((entry) => entry.id)).size).toBe(3);
    expect(items.slice(1).map((entry) => entry.transactionId)).toEqual([
      first.transactionId,
      second.transactionId,
    ]);
    expect(
      items.some((entry) => entry.transactionId === later.transactionId),
    ).toBe(false);
    const refreshed = await getPage(input.walletId);
    expect(refreshed.items).toHaveLength(4);
    expect(refreshed.nextCursor).toBeNull();
    expect(refreshed.items[0]).not.toHaveProperty('sequenceNumber');
  });

  test('empty wallet has an empty ledger and exact zero reconciliation', async () => {
    const wallet = await openWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(await getPage(wallet.id)).toEqual({ items: [], nextCursor: null });
    expect(await reconcile(wallet.id)).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '0.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
  });

  test.each(['0', '-1', '101', '1.5', '1e1', '', 'abc'])(
    'invalid page limit %j returns 400',
    async (limit) => {
      const input = await createInput();
      expect(
        (
          await fetch(
            `${baseUrl}/wallets/${input.walletId}/ledger?limit=${encodeURIComponent(limit)}`,
          )
        ).status,
      ).toBe(400);
    },
  );

  test('malformed, cross-wallet and unknown query parameters are rejected', async () => {
    const input = await createInput();
    await submit.execute(input, randomUUID());
    const page = await getPage(input.walletId, '?limit=1');
    const another = await createInput();
    expect(
      (
        await fetch(
          `${baseUrl}/wallets/${another.walletId}/ledger?cursor=${page.nextCursor}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(
          `${baseUrl}/wallets/${input.walletId}/ledger?cursor=not-json`,
        )
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${baseUrl}/wallets/${input.walletId}/ledger?offset=1`))
        .status,
    ).toBe(400);
  });

  test('missing resources return 404 and malformed UUID returns 400', async () => {
    for (const path of [
      `/wallets/${randomUUID()}/ledger`,
      `/wagering/transactions/${randomUUID()}`,
      '/providers/absent/wagering/transactions/absent',
    ]) {
      expect((await fetch(`${baseUrl}${path}`)).status).toBe(404);
    }
    expect(
      (
        await fetch(`${baseUrl}/wallets/${randomUUID()}/reconciliation`, {
          method: 'POST',
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(`${baseUrl}/wagering/transactions/not-a-uuid`)).status,
    ).toBe(400);
  });

  test('reconciliation preserves cents at the maximum supported monetary amount', async () => {
    const wallet = await openWallet.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '9999999999999999.99', currency: 'BRL' },
    });
    const result = await reconcile(wallet.id);
    expect(result.storedBalance.amount).toBe('9999999999999999.99');
    expect(result.calculatedBalance).toEqual(result.storedBalance);
    expect(result.difference.amount).toBe('0.00');
    expect(result.checkedEntries).toBe(1);
  });

  test('reconciliation remains consistent during simultaneous debits', async () => {
    const input = await createInput();
    const operations = Promise.all(
      Array.from({ length: 20 }, () =>
        submit.execute(
          {
            ...input,
            externalTransactionId: randomUUID(),
            money: { amount: '0.01', currency: 'BRL' },
          },
          randomUUID(),
        ),
      ),
    );
    const checks = await Promise.all(
      Array.from({ length: 20 }, () => reconcile(input.walletId)),
    );
    await operations;
    expect(
      checks.every(
        (result) => result.consistent && result.difference.amount === '0.00',
      ),
    ).toBe(true);
    const final = await reconcile(input.walletId);
    expect(final.storedBalance.amount).toBe('99.80');
    expect(final.checkedEntries).toBe(21);
  });

  test('divergence is reported, logged and counted without silently correcting balance', async () => {
    const input = await createInput();
    const before = await getMismatchCount();
    const log = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Test database only: bypass the protection to simulate preexisting corruption.
      await database.orm.em.fork().transactional(async (em) => {
        await em.execute(
          'alter table wallets disable trigger wallet_balance_matches_ledger',
        );
        await em.execute('update wallets set balance = 99 where id = ?', [
          input.walletId,
        ]);
        await em.execute(
          'alter table wallets enable trigger wallet_balance_matches_ledger',
        );
      });
      const response = await fetch(
        `${baseUrl}/wallets/${input.walletId}/reconciliation`,
        {
          method: 'POST',
          headers: { 'x-correlation-id': 'reconciliation-test' },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        consistent: false,
        storedBalance: { amount: '99.00' },
        calculatedBalance: { amount: '100.00' },
        difference: { amount: '-1.00' },
      });
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          level: 'warn',
          event: 'wallet_reconciliation_mismatch',
          walletId: input.walletId,
          correlationId: 'reconciliation-test',
        }),
      );
      expect(await getMismatchCount()).toBe(before + 1);
      const unchanged = await database.orm.em
        .fork()
        .findOneOrFail(WalletSchema, { id: input.walletId });
      expect(unchanged.balance).toBe('99.00');
    } finally {
      await database.orm.em.execute(
        'update wallets set balance = 100 where id = ?',
        [input.walletId],
      );
      log.mockRestore();
    }
  });
});
