import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { rejects } from 'node:assert/strict';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { SubmitWager } from '../../src/application/wagering/submit-wager';
import { RetryPendingReferences } from '../../src/application/wagering/retry-pending-references';
import type { SubmitWagerInput } from '../../src/application/wagering/wager.contracts';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/entities/wager-transaction';
import { connectDatabase } from '../../src/infrastructure/persistence/database';
import { PostgresWageringUnitOfWork } from '../../src/infrastructure/persistence/repositories/postgres-wagering-unit-of-work';
import { PostgresWalletRepository } from '../../src/infrastructure/persistence/repositories/postgres-wallet.repository';
import { WalletSchema } from '../../src/infrastructure/persistence/schemas/wallet.schema';
import { WagerTransactionSchema } from '../../src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WalletLedgerEntrySchema } from '../../src/infrastructure/persistence/schemas/wallet-ledger-entry.schema';
import { createTestDatabase } from '../support/postgres-test-database';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let submit: SubmitWager;
let retry: RetryPendingReferences;
let openWallet: OpenWallet;

beforeAll(async () => {
  database = await createTestDatabase();
  const unitOfWork = new PostgresWageringUnitOfWork(database.orm);
  submit = new SubmitWager(unitOfWork);
  retry = new RetryPendingReferences(unitOfWork);
  openWallet = new OpenWallet(new PostgresWalletRepository(database.orm));
}, 30000);

afterAll(async () => {
  if (database) {
    await database.close();
  }
});

async function createBet(): Promise<SubmitWagerInput> {
  const wallet = await openWallet.execute({
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
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

function reversal(reference: SubmitWagerInput, kind: Kind): SubmitWagerInput {
  return {
    ...reference,
    kind,
    externalTransactionId: randomUUID(),
    referenceExternalTransactionId: reference.externalTransactionId,
  };
}

async function getTransaction(id: string) {
  return database.orm.em.fork().findOneOrFail(WagerTransactionSchema, { id });
}

async function assertBalance(walletId: string, balance: string): Promise<void> {
  const stored = await database.orm.em
    .fork()
    .findOneOrFail(WalletSchema, { id: walletId });
  expect(stored.balance).toBe(balance);
  const rows = await database.orm.em.execute<{ balance: string }[]>(
    `
    select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(18,2)::text as balance
    from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  expect(rows[0]?.balance).toBe(balance);
}

describe('Reversals and pending reference recovery', () => {
  test('REFUND restores a processed BET and replay does not credit twice', async () => {
    const bet = await createBet();
    await submit.execute(bet, randomUUID());
    const input = reversal(bet, Kind.Refund);
    const key = randomUUID();
    const refund = await submit.execute(input, key);
    expect(refund.status).toBe(Status.Processed);
    expect(await submit.execute(input, key)).toEqual({
      ...refund,
      idempotentReplay: true,
    });
    await assertBalance(bet.walletId, '100.00');
  });

  test.each([Kind.Refund, Kind.Rollback])(
    'concurrent distinct %s requests reverse the reference only once',
    async (kind) => {
      const bet = await createBet();
      await submit.execute(bet, randomUUID());
      const results = await Promise.all([
        submit.execute(reversal(bet, kind), randomUUID()),
        submit.execute(reversal(bet, kind), randomUUID()),
      ]);
      expect(
        results.filter((result) => result.status === Status.Processed),
      ).toHaveLength(1);
      expect(
        results.filter(
          (result) => result.failureCode === 'REFERENCE_ALREADY_REVERSED',
        ),
      ).toHaveLength(1);
      await assertBalance(bet.walletId, '100.00');
    },
  );

  test.each([Kind.Bet, Kind.Win, Kind.Refund])(
    'ROLLBACK inverts %s',
    async (kind) => {
      const bet = await createBet();
      let reference: SubmitWagerInput = { ...bet, kind };
      if (kind === Kind.Refund) {
        await submit.execute(bet, randomUUID());
        reference = reversal(bet, Kind.Refund);
      }
      await submit.execute(reference, randomUUID());
      const rollback = await submit.execute(
        reversal(reference, Kind.Rollback),
        randomUUID(),
      );
      expect(rollback.status).toBe(Status.Processed);
      await assertBalance(
        bet.walletId,
        kind === Kind.Refund ? '90.00' : '100.00',
      );
    },
  );

  test('REFUND and ROLLBACK each have their own reversal limit', async () => {
    const bet = await createBet();
    await submit.execute(bet, randomUUID());
    await submit.execute(reversal(bet, Kind.Refund), randomUUID());
    expect(
      (await submit.execute(reversal(bet, Kind.Rollback), randomUUID())).status,
    ).toBe(Status.Processed);
    await assertBalance(bet.walletId, '110.00');
  });

  test('partial reversal and incompatible reference kinds are auditable rejections', async () => {
    const bet = await createBet();
    await submit.execute(bet, randomUUID());
    const partial = await submit.execute(
      {
        ...reversal(bet, Kind.Refund),
        money: { amount: '5.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    expect(partial.failureCode).toBe('REVERSAL_AMOUNT_MISMATCH');
    const win = { ...bet, externalTransactionId: randomUUID(), kind: Kind.Win };
    await submit.execute(win, randomUUID());
    const wrongKind = await submit.execute(
      reversal(win, Kind.Refund),
      randomUUID(),
    );
    expect(wrongKind.failureCode).toBe('INVALID_REFERENCE_KIND');
    expect(
      await database.orm.em.fork().count(WalletLedgerEntrySchema, {
        transactionId: partial.transactionId,
      }),
    ).toBe(0);
    await assertBalance(bet.walletId, '100.00');
  });

  test('reversal debit without funds gets a distinct terminal failure code', async () => {
    const bet = await createBet();
    const win = {
      ...bet,
      kind: Kind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    };
    await submit.execute(win, randomUUID());
    await submit.execute(
      {
        ...bet,
        externalTransactionId: randomUUID(),
        money: { amount: '140.00', currency: 'BRL' },
      },
      randomUUID(),
    );
    const rollback = reversal(win, Kind.Rollback);
    const key = randomUUID();
    const rejected = await submit.execute(rollback, key);
    expect(rejected.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(
      await database.orm.em.fork().count(WalletLedgerEntrySchema, {
        transactionId: rejected.transactionId,
      }),
    ).toBe(0);
    await assertBalance(bet.walletId, '10.00');
    expect(await submit.execute(rollback, key)).toEqual({
      ...rejected,
      idempotentReplay: true,
    });
  });

  test.each([Kind.Refund, Kind.Rollback])(
    '%s before BET is recovered once by concurrent workers',
    async (kind) => {
      const bet = await createBet();
      const input = reversal(bet, kind);
      const key = randomUUID();
      const pending = await submit.execute(input, key);
      expect(pending.status).toBe(Status.PendingReference);
      const record = await getTransaction(pending.transactionId);
      expect(record.nextReferenceAttemptAt).not.toBeNull();
      await submit.execute(bet, randomUUID());
      const now = new Date(record.createdAt.getTime() + 1500);
      const attempted = await Promise.all([
        retry.execute(now),
        retry.execute(now),
      ]);
      expect(attempted.reduce((sum, count) => sum + count, 0)).toBe(1);
      const processed = await getTransaction(pending.transactionId);
      expect(processed.status).toBe(Status.Processed);
      expect(processed.referenceAttempts).toBe(1);
      expect(processed.nextReferenceAttemptAt).toBeNull();
      expect((await submit.execute(input, key)).status).toBe(Status.Processed);
      expect(
        await database.orm.em
          .fork()
          .count(WalletLedgerEntrySchema, { transactionId: processed.id }),
      ).toBe(1);
      await assertBalance(bet.walletId, '100.00');
    },
  );

  test('backoff persists across attempts and missing reference expires after 24 hours', async () => {
    const bet = await createBet();
    const pending = await submit.execute(
      reversal(bet, Kind.Refund),
      randomUUID(),
    );
    const initial = await getTransaction(pending.transactionId);
    const due = new Date(initial.createdAt.getTime() + 1000);
    expect(await retry.execute(new Date(due.getTime() - 1))).toBe(0);
    expect(await retry.execute(due)).toBe(1);
    const first = await getTransaction(pending.transactionId);
    expect(first.referenceAttempts).toBe(1);
    expect(first.nextReferenceAttemptAt?.getTime()).toBe(due.getTime() + 2000);
    expect(await retry.execute(due)).toBe(0);
    const expiredAt = new Date(
      initial.createdAt.getTime() + 24 * 60 * 60 * 1000,
    );
    expect(await retry.execute(expiredAt)).toBe(1);
    const expired = await getTransaction(pending.transactionId);
    expect(expired.status).toBe(Status.Rejected);
    expect(expired.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(expired.nextReferenceAttemptAt).toBeNull();
    expect(await retry.execute(expiredAt)).toBe(0);
    await assertBalance(bet.walletId, '100.00');
  });

  test('a new database connection recovers a pending reference after restart', async () => {
    const bet = await createBet();
    const pending = await submit.execute(
      reversal(bet, Kind.Rollback),
      randomUUID(),
    );
    const record = await getTransaction(pending.transactionId);
    await submit.execute(bet, randomUUID());
    const restarted = await connectDatabase(database.url);
    try {
      const recovered = new RetryPendingReferences(
        new PostgresWageringUnitOfWork(restarted),
      );
      expect(
        await recovered.execute(new Date(record.createdAt.getTime() + 1500)),
      ).toBe(1);
    } finally {
      await restarted.close();
    }
    expect((await getTransaction(pending.transactionId)).status).toBe(
      Status.Processed,
    );
    await assertBalance(bet.walletId, '100.00');
  });

  test('failure while recovering rolls back the status, attempt and credit', async () => {
    const bet = await createBet();
    const pending = await submit.execute(
      reversal(bet, Kind.Refund),
      randomUUID(),
    );
    const record = await getTransaction(pending.transactionId);
    await submit.execute(bet, randomUUID());
    const otherBet = {
      ...(await createBet()),
      money: { amount: '11.00', currency: 'BRL' },
    };
    const otherPending = await submit.execute(
      reversal(otherBet, Kind.Refund),
      randomUUID(),
    );
    await submit.execute(otherBet, randomUUID());
    const otherRecord = await getTransaction(otherPending.transactionId);
    const now = new Date(
      Math.max(record.createdAt.getTime(), otherRecord.createdAt.getTime()) +
        1500,
    );
    await database.orm.em.execute(`
      create function fail_recovery_test() returns trigger language plpgsql as $$
      begin
        if NEW.amount = 10 then raise exception 'injected recovery failure'; end if;
        return NEW;
      end $$;
      create trigger fail_recovery_test before insert on wallet_ledger_entries for each row execute function fail_recovery_test();
    `);
    try {
      await rejects(retry.execute(now), /injected recovery failure/);
      const unchanged = await getTransaction(pending.transactionId);
      expect(unchanged.status).toBe(Status.PendingReference);
      expect(unchanged.referenceAttempts).toBe(0);
      await assertBalance(bet.walletId, '90.00');
      expect((await getTransaction(otherPending.transactionId)).status).toBe(
        Status.Processed,
      );
      await assertBalance(otherBet.walletId, '100.00');
    } finally {
      await database.orm.em.execute(
        'drop trigger fail_recovery_test on wallet_ledger_entries; drop function fail_recovery_test()',
      );
    }
    expect(await retry.execute(now)).toBe(1);
    await assertBalance(bet.walletId, '100.00');
  });

  test('HTTP accepts reversals and the scheduled worker resolves them automatically', async () => {
    const previousOutboxSetting = process.env.OUTBOX_PUBLISHER_ENABLED;
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    const previousUrl = process.env.DATABASE_URL;
    const previousEnabled = process.env.REFERENCE_RECOVERY_ENABLED;
    process.env.DATABASE_URL = database.url;
    process.env.REFERENCE_RECOVERY_ENABLED = 'true';
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const baseUrl = await app.getUrl();
      const bet = await createBet();
      const input = reversal(bet, Kind.Refund);
      const response = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(202);
      await submit.execute(bet, randomUUID());
      let status = Status.PendingReference;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const record = await database.orm.em
          .fork()
          .findOneOrFail(WagerTransactionSchema, {
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
          });
        status = record.status;
        if (status === Status.Processed) {
          break;
        }
        await Bun.sleep(50);
      }
      expect(status).toBe(Status.Processed);
      await assertBalance(bet.walletId, '100.00');
    } finally {
      await app.close();
      if (previousOutboxSetting === undefined) {
        delete process.env.OUTBOX_PUBLISHER_ENABLED;
      } else {
        process.env.OUTBOX_PUBLISHER_ENABLED = previousOutboxSetting;
      }
      if (previousUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousUrl;
      }
      if (previousEnabled === undefined) {
        delete process.env.REFERENCE_RECOVERY_ENABLED;
      } else {
        process.env.REFERENCE_RECOVERY_ENABLED = previousEnabled;
      }
    }
  }, 15000);
});
