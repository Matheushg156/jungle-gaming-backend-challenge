import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction';
import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry';
import { createTestDatabase } from '../support/postgres-test-database';
import { AppModule } from '../../src/app.module';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import { connectDatabase } from '../../src/infrastructure/persistence/database';
import { PostgresWalletRepository } from '../../src/infrastructure/persistence/repositories/postgres-wallet.repository';
import { WalletSchema } from '../../src/infrastructure/persistence/schemas/wallet.schema';
import { WagerTransactionSchema } from '../../src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WalletLedgerEntrySchema } from '../../src/infrastructure/persistence/schemas/wallet-ledger-entry.schema';

// Every run owns a fresh database. The configured test database is never cleared.
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;
let testUrl: string;
let openWallet: OpenWallet;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousRecoverySetting = process.env.REFERENCE_RECOVERY_ENABLED;

const previousOutboxSetting = process.env.OUTBOX_PUBLISHER_ENABLED;
beforeAll(async () => {
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  database = await createTestDatabase();
  orm = database.orm;
  testUrl = database.url;
  openWallet = new OpenWallet(new PostgresWalletRepository(orm));

  process.env.DATABASE_URL = testUrl;
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
  if (previousRecoverySetting === undefined) {
    delete process.env.REFERENCE_RECOVERY_ENABLED;
  } else {
    process.env.REFERENCE_RECOVERY_ENABLED = previousRecoverySetting;
  }
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
  try {
    if (app) {
      await app.close();
    }
  } finally {
    if (database) {
      await database.close();
    }
  }
});

const createInput = (amount = '100.00') => ({
  playerId: randomUUID(),
  initialBalance: { amount, currency: 'BRL' },
});

async function postWallet(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function expectFailure(
  operation: Promise<unknown>,
  message?: string,
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    if (message) {
      expect(error instanceof Error ? error.message : '').toContain(message);
    }
    return;
  }
  throw new Error('Expected operation to fail');
}

describe('Wallet persistence and HTTP with real PostgreSQL', () => {
  test('applies, reverses and reapplies the migration before writing data', async () => {
    await orm.getMigrator().down({ to: 0 });
    const rows = await orm.em.execute<{ name: string | null }[]>(
      "select to_regclass('public.wallets')::text as name",
    );
    expect(rows[0]?.name).toBeNull();
    await orm.getMigrator().up();
  });

  test('opens wallet with OPENING and exact credit, keeping version one', async () => {
    const wallet = await openWallet.execute(createInput('9999999999999999.99'));
    const em = orm.em.fork();
    const stored = await em.findOneOrFail(WalletSchema, { id: wallet.id });
    const transaction = await em.findOneOrFail(WagerTransactionSchema, {
      walletId: wallet.id,
    });
    const entry = await em.findOneOrFail(WalletLedgerEntrySchema, {
      walletId: wallet.id,
    });

    expect(stored.balance).toBe('9999999999999999.99');
    expect(stored.version).toBe(1);
    expect(transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(entry.transactionId).toBe(transaction.id);
    expect(entry.balanceBefore).toBe('0.00');
    expect(entry.balanceAfter).toBe(stored.balance);
    expect(entry.amount).toBe(stored.balance);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('opens zero-balance wallet without OPENING or ledger', async () => {
    const wallet = await openWallet.execute(createInput('0.00'));
    expect(
      await orm.em
        .fork()
        .count(WagerTransactionSchema, { walletId: wallet.id }),
    ).toBe(0);
    expect(
      await orm.em
        .fork()
        .count(WalletLedgerEntrySchema, { walletId: wallet.id }),
    ).toBe(0);
  });

  test('allows different currencies for the same player', async () => {
    const input = createInput();
    await openWallet.execute(input);
    const usd = await openWallet.execute({
      ...input,
      initialBalance: { amount: '25.00', currency: 'USD' },
    });
    expect(usd.currency).toBe('USD');
  });

  test('concurrent duplicate openings commit exactly one wallet and credit', async () => {
    const input = createInput();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => openWallet.execute(input)),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(7);
    const wallet = await orm.em
      .fork()
      .findOneOrFail(WalletSchema, { playerId: input.playerId });
    expect(
      await orm.em
        .fork()
        .count(WalletLedgerEntrySchema, { walletId: wallet.id }),
    ).toBe(1);
  });

  test('rolls back wallet and OPENING if ledger insertion fails', async () => {
    const input = createInput('13.37');
    await orm.em.execute(`
      create function fail_test_ledger() returns trigger language plpgsql as $$
      begin
        if NEW.amount = 13.37 then raise exception 'injected ledger failure'; end if;
        return NEW;
      end $$;
      create trigger fail_test_ledger before insert on wallet_ledger_entries
        for each row execute function fail_test_ledger();
    `);
    try {
      await expectFailure(openWallet.execute(input), 'injected ledger failure');
      expect(
        await orm.em.fork().count(WalletSchema, { playerId: input.playerId }),
      ).toBe(0);
      expect(
        await orm.em
          .fork()
          .count(WagerTransactionSchema, { playerId: input.playerId }),
      ).toBe(0);
    } finally {
      await orm.em.execute(
        'drop trigger fail_test_ledger on wallet_ledger_entries; drop function fail_test_ledger()',
      );
    }
  });

  test('database rejects negative balance and balance update without ledger', async () => {
    const wallet = await openWallet.execute(createInput());
    await expectFailure(
      orm.em.execute('update wallets set balance = -1 where id = ?', [
        wallet.id,
      ]),
    );
    await expectFailure(
      orm.em.execute('update wallets set balance = 101 where id = ?', [
        wallet.id,
      ]),
      'does not match ledger',
    );
    const reloaded = await new PostgresWalletRepository(orm).findById(
      wallet.id,
    );
    expect(reloaded?.balance.toString()).toBe('100.00');
  });

  test('database prevents ledger mutation and duplicate transaction entries', async () => {
    const wallet = await openWallet.execute(createInput());
    await expectFailure(
      orm.em.execute(
        'update wallet_ledger_entries set amount = amount where wallet_id = ?',
        [wallet.id],
      ),
      'immutable',
    );
    await expectFailure(
      orm.em.execute('delete from wallet_ledger_entries where wallet_id = ?', [
        wallet.id,
      ]),
      'immutable',
    );
    await expectFailure(
      orm.em.execute('truncate wallet_ledger_entries'),
      'immutable',
    );
    await expectFailure(
      orm.em.execute(
        `insert into wallet_ledger_entries
      select ?, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
      from wallet_ledger_entries where wallet_id = ?`,
        [randomUUID(), wallet.id],
      ),
    );
  });

  test('rehydrates balance exactly through a fresh database connection', async () => {
    const wallet = await openWallet.execute(createInput('1234.56'));
    const restarted = await connectDatabase(testUrl);
    try {
      const reloaded = await new PostgresWalletRepository(restarted).findById(
        wallet.id,
      );
      expect(reloaded?.balance.toJSON()).toEqual({
        amount: '1234.56',
        currency: 'BRL',
      });
      expect(reloaded?.version).toBe(1);
    } finally {
      await restarted.close();
    }
  });

  test('HTTP creates, retrieves and rejects duplicate wallet', async () => {
    const input = createInput();
    const created = await postWallet(input);
    expect(created.status).toBe(201);
    const body: unknown = await created.json();
    const record = await orm.em
      .fork()
      .findOneOrFail(WalletSchema, { playerId: input.playerId });
    expect(body).toEqual({
      id: record.id,
      playerId: input.playerId,
      balance: input.initialBalance,
      version: 1,
    });
    const retrieved = await fetch(`${baseUrl}/wallets/${record.id}`);
    expect(retrieved.status).toBe(200);
    expect(await retrieved.json()).toEqual(body);
    expect((await postWallet(input)).status).toBe(409);
  });

  test.each([
    {
      playerId: 'invalid',
      initialBalance: { amount: '1.00', currency: 'BRL' },
    },
    { playerId: randomUUID() },
    { ...createInput(), initialBalance: null },
    { ...createInput(), initialBalance: { amount: 100, currency: 'BRL' } },
    createInput('-1.00'),
    createInput('1.001'),
    { ...createInput(), unexpected: true as const },
  ])('HTTP rejects invalid input %j', async (input) => {
    expect((await postWallet(input)).status).toBe(400);
  });

  test('HTTP distinguishes malformed and missing wallet identifiers', async () => {
    expect((await fetch(`${baseUrl}/wallets/invalid`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/wallets/${randomUUID()}`)).status).toBe(
      404,
    );
  });

  test('every stored wallet matches its ledger', async () => {
    const divergent = await orm.em.execute<{ id: string }[]>(`
      select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      group by w.id having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)
    `);
    expect(divergent).toEqual([]);
  });
});
