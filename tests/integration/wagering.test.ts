import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { rejects } from 'node:assert/strict';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { LockMode } from '@mikro-orm/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { SubmitWager } from '../../src/application/wagering/submit-wager';
import type {
  SubmitWagerInput,
  SubmitWagerResult,
} from '../../src/application/wagering/wager.contracts';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/entities/wager-transaction';
import { DomainError } from '../../src/domain/errors/domain-error';
import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry';
import { PostgresWageringUnitOfWork } from '../../src/infrastructure/persistence/repositories/postgres-wagering-unit-of-work';
import { connectDatabase } from '../../src/infrastructure/persistence/database';
import { PostgresWalletRepository } from '../../src/infrastructure/persistence/repositories/postgres-wallet.repository';
import { WalletSchema } from '../../src/infrastructure/persistence/schemas/wallet.schema';
import { WagerTransactionSchema } from '../../src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WalletLedgerEntrySchema } from '../../src/infrastructure/persistence/schemas/wallet-ledger-entry.schema';
import { createTestDatabase } from '../support/postgres-test-database';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let submit: SubmitWager;
let openWallet: OpenWallet;
let app: INestApplication;
let baseUrl: string;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousRecoverySetting = process.env.REFERENCE_RECOVERY_ENABLED;

beforeAll(async () => {
  database = await createTestDatabase();
  submit = new SubmitWager(new PostgresWageringUnitOfWork(database.orm));
  openWallet = new OpenWallet(new PostgresWalletRepository(database.orm));
  process.env.DATABASE_URL = database.url;
  process.env.REFERENCE_RECOVERY_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 30000);

afterAll(async () => {
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

async function createInput(amount = '25.00'): Promise<SubmitWagerInput> {
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
    money: { amount, currency: 'BRL' },
  };
}

async function postWager(input: unknown, key?: string): Promise<Response> {
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(input),
  });
}

async function assertConsistent(): Promise<void> {
  const divergent = await database.orm.em.execute<{ id: string }[]>(`
    select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
    group by w.id having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)
  `);
  expect(divergent).toEqual([]);
}

describe('Wager processing with real PostgreSQL', () => {
  test('BET debits, WIN credits and LOSS changes neither balance nor version', async () => {
    const input = await createInput();
    expect((await submit.execute(input, randomUUID())).balance.amount).toBe(
      '75.00',
    );
    const win = {
      ...input,
      externalTransactionId: randomUUID(),
      kind: Kind.Win,
      money: { amount: '10.00', currency: 'BRL' },
    };
    expect((await submit.execute(win, randomUUID())).balance.amount).toBe(
      '85.00',
    );
    const loss = {
      ...input,
      externalTransactionId: randomUUID(),
      kind: Kind.Loss,
      money: { amount: '0.00', currency: 'BRL' },
    };
    const result = await submit.execute(loss, randomUUID());
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('85.00');
    const wallet = await database.orm.em
      .fork()
      .findOneOrFail(WalletSchema, { id: input.walletId });
    expect(wallet.version).toBe(3);
    expect(
      await database.orm.em.fork().count(WalletLedgerEntrySchema, {
        transactionId: result.transactionId,
      }),
    ).toBe(0);
    await assertConsistent();
  });

  test('50 simultaneous copies debit once', async () => {
    const input = await createInput();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit.execute(input, key)),
    );
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
      1,
    );
    expect(results.every((result) => result.balance.amount === '75.00')).toBe(
      true,
    );
    expect(
      await database.orm.em.fork().count(WalletLedgerEntrySchema, {
        walletId: input.walletId,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);
    await assertConsistent();
  });

  test('two bets of 80 compete for 100: exactly one processed and one rejected', async () => {
    const input = await createInput('80.00');
    const results = await Promise.all([
      submit.execute(input, randomUUID()),
      submit.execute(
        { ...input, externalTransactionId: randomUUID() },
        randomUUID(),
      ),
    ]);
    expect(
      results.filter((result) => result.status === Status.Processed),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.failureCode === 'INSUFFICIENT_FUNDS'),
    ).toHaveLength(1);
    const wallet = await database.orm.em
      .fork()
      .findOneOrFail(WalletSchema, { id: input.walletId });
    expect(wallet.balance).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(
      await database.orm.em.fork().count(WalletLedgerEntrySchema, {
        walletId: input.walletId,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);
    await assertConsistent();
  });

  test('replay returns the original balance even after subsequent transactions', async () => {
    const input = await createInput();
    const key = randomUUID();
    const original = await submit.execute(input, key);
    await submit.execute(
      { ...input, externalTransactionId: randomUUID() },
      randomUUID(),
    );
    const replay = await submit.execute(input, key);
    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance.amount).toBe('75.00');
    const reconnected = await connectDatabase(database.url);
    try {
      const restarted = new SubmitWager(
        new PostgresWageringUnitOfWork(reconnected),
      );
      expect(await restarted.execute(input, key)).toEqual(replay);
    } finally {
      await reconnected.close();
    }
    await assertConsistent();
  });

  test('rejection is persisted and cannot become processed when funds arrive later', async () => {
    const input = await createInput('110.00');
    const key = randomUUID();
    const rejected = await submit.execute(input, key);
    expect(rejected.status).toBe(Status.Rejected);
    await submit.execute(
      { ...input, externalTransactionId: randomUUID(), kind: Kind.Win },
      randomUUID(),
    );
    expect(await submit.execute(input, key)).toEqual({
      ...rejected,
      idempotentReplay: true,
    });
    expect(
      await database.orm.em.fork().count(WalletLedgerEntrySchema, {
        transactionId: rejected.transactionId,
      }),
    ).toBe(0);
    await assertConsistent();
  });

  test('same key with different payload conflicts without modifying balances', async () => {
    const input = await createInput();
    const key = randomUUID();
    await submit.execute(input, key);
    await rejects(
      submit.execute(
        { ...input, money: { amount: '26.00', currency: 'BRL' } },
        key,
      ),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    await rejects(
      submit.execute(input, randomUUID()),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === 'EXTERNAL_TRANSACTION_CONFLICT',
    );
    await rejects(
      submit.execute({ ...input, walletId: randomUUID() }, key),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    await assertConsistent();
  });

  test('different wallets racing for the same key cannot both apply', async () => {
    const [first, second] = await Promise.all([createInput(), createInput()]);
    const key = randomUUID();
    const results = await Promise.allSettled([
      submit.execute(first, key),
      submit.execute(second, key),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await assertConsistent();
  });

  test('a locked wallet does not prevent another wallet from processing', async () => {
    const [blockedInput, independentInput] = await Promise.all([
      createInput(),
      createInput(),
    ]);
    const blocker = database.orm.em.fork();
    await blocker.begin();
    await blocker.findOneOrFail(
      WalletSchema,
      { id: blockedInput.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    let completed = false;
    const blocked = submit
      .execute(blockedInput, randomUUID())
      .then((result) => {
        completed = true;
        return result;
      });
    try {
      const independent = await submit.execute(independentInput, randomUUID());
      expect(independent.status).toBe(Status.Processed);
      expect(completed).toBe(false);
    } finally {
      await blocker.rollback();
      await blocked;
    }
    await assertConsistent();
  });

  test('a ledger failure rolls back the wager, result and debit; retry can then succeed', async () => {
    const input = await createInput('13.37');
    const key = randomUUID();
    await database.orm.em.execute(`
      create function fail_wager_test_ledger() returns trigger language plpgsql as $$
      begin
        if NEW.amount = 13.37 then raise exception 'injected wager ledger failure'; end if;
        return NEW;
      end $$;
      create trigger fail_wager_test_ledger before insert on wallet_ledger_entries
        for each row execute function fail_wager_test_ledger();
    `);
    try {
      await rejects(
        submit.execute(input, key),
        /injected wager ledger failure/,
      );
      const wallet = await database.orm.em
        .fork()
        .findOneOrFail(WalletSchema, { id: input.walletId });
      expect(wallet.balance).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(
        await database.orm.em
          .fork()
          .count(WagerTransactionSchema, { idempotencyKey: key }),
      ).toBe(0);
    } finally {
      await database.orm.em.execute(
        'drop trigger fail_wager_test_ledger on wallet_ledger_entries; drop function fail_wager_test_ledger()',
      );
    }
    const retried = await submit.execute(input, key);
    expect(retried.idempotentReplay).toBe(false);
    expect(retried.balance.amount).toBe('86.63');
    await assertConsistent();
  });

  test('database rejects a processed financial transaction without a ledger entry', async () => {
    const result = await submit.execute(await createInput(), randomUUID());
    const em = database.orm.em.fork();
    const source = await em.findOneOrFail(WagerTransactionSchema, {
      id: result.transactionId,
    });
    const id = randomUUID();
    await rejects(
      em.transactional(async (transactional) => {
        transactional.create(WagerTransactionSchema, {
          ...source,
          id,
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          result: { ...result, transactionId: id },
        });
        await transactional.flush();
      }),
      /must have matching ledger entry/,
    );
    await assertConsistent();
  });

  test('player and currency mismatch are auditable rejections with no ledger', async () => {
    const input = await createInput();
    for (const overrides of [
      { playerId: randomUUID() },
      { money: { amount: '25.00', currency: 'USD' } },
    ]) {
      const result = await submit.execute(
        { ...input, ...overrides, externalTransactionId: randomUUID() },
        randomUUID(),
      );
      expect(result.status).toBe(Status.Rejected);
      expect(result.balance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(
        await database.orm.em.fork().count(WalletLedgerEntrySchema, {
          transactionId: result.transactionId,
        }),
      ).toBe(0);
    }
    await assertConsistent();
  });

  test('WIN reference is checked; missing references persist as pending', async () => {
    const input = await createInput();
    await submit.execute(input, randomUUID());
    const win = {
      ...input,
      kind: Kind.Win,
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: input.externalTransactionId,
    };
    expect((await submit.execute(win, randomUUID())).status).toBe(
      Status.Processed,
    );
    const invalid = await submit.execute(
      { ...win, externalTransactionId: randomUUID(), roundId: 'other' },
      randomUUID(),
    );
    expect(invalid.failureCode).toBe('REFERENCE_MISMATCH');
    const pending = await submit.execute(
      {
        ...win,
        externalTransactionId: randomUUID(),
        referenceExternalTransactionId: 'missing',
      },
      randomUUID(),
    );
    expect(pending.status).toBe(Status.PendingReference);
    await assertConsistent();
  });

  test('terminal transaction cannot be altered in SQL', async () => {
    const result = await submit.execute(await createInput(), randomUUID());
    await rejects(
      database.orm.em.execute(
        "update wager_transactions set status = 'REJECTED', failure_code = 'OTHER' where id = ?",
        [result.transactionId],
      ),
      /Terminal transaction is immutable/,
    );
    await assertConsistent();
  });

  test('50 copies across three independent processes debit only once', async () => {
    const input = await createInput();
    const key = randomUUID();
    const children = [17, 17, 16].map((count) => {
      const process = Bun.spawn(
        [globalThis.process.execPath, 'tests/support/submit-wager-process.ts'],
        {
          env: {
            ...globalThis.process.env,
            WAGER_TEST_DATABASE_URL: database.url,
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      return { process, count, reader: process.stdout.getReader() };
    });

    try {
      // A barrier ensures all three database connections exist before any request starts.
      await Promise.all(
        children.map(async ({ reader }) => {
          const ready = await reader.read();
          expect(new TextDecoder().decode(ready.value)).toBe('READY\n');
        }),
      );
      for (const { process, count } of children) {
        await process.stdin.write(
          JSON.stringify(Array.from({ length: count }, () => ({ input, key }))),
        );
        await process.stdin.end();
      }

      const batches = await Promise.all(
        children.map(async ({ process, reader }) => {
          let output = '';
          const decoder = new TextDecoder();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              break;
            }
            output += decoder.decode(chunk.value, { stream: true });
          }
          expect(await process.exited).toBe(0);
          expect(await new Response(process.stderr).text()).toBe('');
          return JSON.parse(output) as SubmitWagerResult[];
        }),
      );
      const results = batches.flat();
      expect(results).toHaveLength(50);
      expect(new Set(results.map((result) => result.transactionId)).size).toBe(
        1,
      );
      expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
        1,
      );
      expect(results.every((result) => result.balance.amount === '75.00')).toBe(
        true,
      );
      const wallet = await database.orm.em
        .fork()
        .findOneOrFail(WalletSchema, { id: input.walletId });
      expect(wallet.balance).toBe('75.00');
      expect(
        await database.orm.em.fork().count(WalletLedgerEntrySchema, {
          walletId: input.walletId,
          direction: LedgerDirection.Debit,
        }),
      ).toBe(1);
      await assertConsistent();
    } finally {
      for (const { process } of children) {
        if (process.exitCode === null) {
          process.kill();
        }
      }
      await Promise.all(children.map(({ process }) => process.exited));
    }
  }, 30000);

  test('HTTP distinguishes missing header, conflict, rejection and pending', async () => {
    const input = await createInput();
    const key = randomUUID();
    expect((await postWager(input)).status).toBe(400);
    expect((await postWager(input, key)).status).toBe(200);
    const replay = await postWager(input, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      idempotentReplay: true,
      balance: { amount: '75.00' },
    });
    expect(
      (
        await postWager(
          { ...input, money: { amount: '26.00', currency: 'BRL' } },
          key,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await postWager(
          {
            ...input,
            externalTransactionId: randomUUID(),
            money: { amount: '99.00', currency: 'BRL' },
          },
          randomUUID(),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await postWager(
          {
            ...input,
            kind: Kind.Win,
            externalTransactionId: randomUUID(),
            referenceExternalTransactionId: 'not-yet',
          },
          randomUUID(),
        )
      ).status,
    ).toBe(202);
    expect(
      (await postWager({ ...input, kind: Kind.Opening }, randomUUID())).status,
    ).toBe(400);
    await assertConsistent();
  });

  test('HTTP lock timeout returns 503 with no effect; same-key retry succeeds', async () => {
    const input = await createInput();
    const key = randomUUID();
    const blocker = database.orm.em.fork();
    await blocker.begin();
    await blocker.findOneOrFail(
      WalletSchema,
      { id: input.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    try {
      const response = await postWager(input, key);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'DATABASE_UNAVAILABLE',
      });
      expect(
        await database.orm.em
          .fork()
          .count(WagerTransactionSchema, { idempotencyKey: key }),
      ).toBe(0);
    } finally {
      await blocker.rollback();
    }
    const retry = await postWager(input, key);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      idempotentReplay: false,
      balance: { amount: '75.00' },
    });
    await assertConsistent();
  }, 15000);
});
