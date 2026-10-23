import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { rejects } from 'node:assert/strict';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import type { SubmitWagerInput } from '../../src/application/wagering/wager.contracts';
import { OpenWallet } from '../../src/application/wallets/open-wallet';
import { SubmitWager } from '../../src/application/wagering/submit-wager';
import { RetryPendingReferences } from '../../src/application/wagering/retry-pending-references';
import { PermanentPersistenceError } from '../../src/application/ports/permanent-persistence-error';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/entities/wager-transaction';
import { PostgresWalletRepository } from '../../src/infrastructure/persistence/repositories/postgres-wallet.repository';
import { PostgresWageringUnitOfWork } from '../../src/infrastructure/persistence/repositories/postgres-wagering-unit-of-work';
import { WalletSchema } from '../../src/infrastructure/persistence/schemas/wallet.schema';
import { WagerTransactionSchema } from '../../src/infrastructure/persistence/schemas/wager-transaction.schema';
import { WalletLedgerEntrySchema } from '../../src/infrastructure/persistence/schemas/wallet-ledger-entry.schema';
import { OutboxMessageSchema } from '../../src/infrastructure/persistence/schemas/outbox-message.schema';
import { createTestDatabase } from '../support/postgres-test-database';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let submit: SubmitWager;
let retry: RetryPendingReferences;
beforeEach(async () => {
  database = await createTestDatabase();
  const unit = new PostgresWageringUnitOfWork(database.orm);
  submit = new SubmitWager(unit);
  retry = new RetryPendingReferences(unit);
}, 30000);
afterEach(async () => {
  await database?.close();
});

async function acceptedRefund() {
  const wallet = await new OpenWallet(
    new PostgresWalletRepository(database.orm),
  ).execute({
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  const bet = {
    providerId: 'provider',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    gameId: 'game',
    roundId: 'round',
    kind: Kind.Bet,
    money: { amount: '10.00', currency: 'BRL' },
  };
  const input = {
    ...bet,
    kind: Kind.Refund,
    externalTransactionId: randomUUID(),
    referenceExternalTransactionId: bet.externalTransactionId,
  };
  const key = randomUUID();
  const pending = await submit.execute(input, key, {
    correlationId: 'permanent-correlation',
    causationId: 'original-message',
  });
  await submit.execute(bet, randomUUID());
  const stored = await database.orm.em
    .fork()
    .findOneOrFail(WagerTransactionSchema, { id: pending.transactionId });
  return {
    input,
    key,
    id: pending.transactionId,
    due: new Date(stored.createdAt.getTime() + 2000),
  };
}

async function rejectRecovery(transactionId: string, sqlState = '23514') {
  // Values originate only from test fixtures, never HTTP inputs.
  await database.orm.em.execute(`
    create function fail_recovery_integrity() returns trigger language plpgsql as $$
    begin
      if new.transaction_id = '${transactionId}'::uuid then
        raise exception 'injected persistence failure' using errcode = '${sqlState}';
      end if;
      return new;
    end $$;
    create trigger fail_recovery_integrity before insert on wallet_ledger_entries
      for each row execute function fail_recovery_integrity();
  `);
}

async function assertConsistent(walletId: string, balance: string) {
  const em = database.orm.em.fork();
  expect((await em.findOneOrFail(WalletSchema, { id: walletId })).balance).toBe(
    balance,
  );
  const rows = await em.execute<{ balance: string }[]>(
    `select sum(case direction when 'CREDIT' then amount else -amount end)::numeric(18,2)::text as balance
    from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  expect(rows[0]?.balance).toBe(balance);
}
async function failedEvents(id: string) {
  return database.orm.em.fork().find(OutboxMessageSchema, {
    eventType: 'WagerTransactionFailed',
    payload: { data: { transactionId: id } },
  });
}

test('a permanent recovery failure commits FAILED and its event after rolling back all financial effects', async () => {
  const pending = await acceptedRefund();
  await rejectRecovery(pending.id);
  expect(await retry.execute(pending.due)).toBe(1);
  const record = await database.orm.em
    .fork()
    .findOneOrFail(WagerTransactionSchema, { id: pending.id });
  expect(record.status).toBe(Status.Failed);
  expect(record.failureCode).toBe('PERSISTENCE_INTEGRITY_FAILURE');
  expect(record.result).toMatchObject({
    status: Status.Failed,
    balance: { amount: '90.00' },
  });
  expect(record.nextReferenceAttemptAt).toBeNull();
  expect(record.referenceAttempts).toBe(1);
  expect(
    await database.orm.em
      .fork()
      .count(WalletLedgerEntrySchema, { transactionId: pending.id }),
  ).toBe(0);
  const events = await failedEvents(pending.id);
  expect(events).toHaveLength(1);
  expect(events[0]?.payload).toMatchObject({
    correlationId: 'permanent-correlation',
    causationId: 'original-message',
    data: { failureCode: 'PERSISTENCE_INTEGRITY_FAILURE' },
  });
  expect(await retry.execute(new Date(pending.due.getTime() + 10000))).toBe(0);
  expect(await failedEvents(pending.id)).toHaveLength(1);
  await assertConsistent(pending.input.walletId, '90.00');
  await rejects(
    database.orm.em.execute(
      "update wager_transactions set status = 'PENDING_REFERENCE' where id = ?",
      [pending.id],
    ),
    /immutable|terminal/i,
  );
});

test('transient recovery errors remain pending and later succeed', async () => {
  const pending = await acceptedRefund();
  await rejectRecovery(pending.id, '40001');
  await rejects(retry.execute(pending.due));
  expect(
    (
      await database.orm.em
        .fork()
        .findOneOrFail(WagerTransactionSchema, { id: pending.id })
    ).status,
  ).toBe(Status.PendingReference);
  expect(await failedEvents(pending.id)).toHaveLength(0);
  await assertConsistent(pending.input.walletId, '90.00');
  await database.orm.em.execute(
    'drop trigger fail_recovery_integrity on wallet_ledger_entries; drop function fail_recovery_integrity()',
  );
  expect(await retry.execute(pending.due)).toBe(1);
  await assertConsistent(pending.input.walletId, '100.00');
});

test('failure of the failure-event write preserves the accepted operation for a later worker', async () => {
  const pending = await acceptedRefund();
  await rejectRecovery(pending.id);
  await database.orm.em.execute(`
    create function fail_failed_event() returns trigger language plpgsql as $$
    begin if new.event_type = 'WagerTransactionFailed' then raise exception 'injected audit failure' using errcode = '23514'; end if; return new; end $$;
    create trigger fail_failed_event before insert on outbox_messages for each row execute function fail_failed_event();
  `);
  await rejects(retry.execute(pending.due), PermanentPersistenceError);
  expect(
    (
      await database.orm.em
        .fork()
        .findOneOrFail(WagerTransactionSchema, { id: pending.id })
    ).status,
  ).toBe(Status.PendingReference);
  expect(await failedEvents(pending.id)).toHaveLength(0);
  await assertConsistent(pending.input.walletId, '90.00');
  await database.orm.em.execute(
    'drop trigger fail_failed_event on outbox_messages; drop function fail_failed_event()',
  );
  await retry.execute(pending.due);
  expect(await failedEvents(pending.id)).toHaveLength(1);
  await assertConsistent(pending.input.walletId, '90.00');
});

test('concurrent permanent recoveries produce one terminal failure; HTTP replay retains its original result', async () => {
  const pending = await acceptedRefund();
  await rejectRecovery(pending.id);
  await Promise.all([retry.execute(pending.due), retry.execute(pending.due)]);
  expect(await failedEvents(pending.id)).toHaveLength(1);
  const win: SubmitWagerInput = {
    ...pending.input,
    kind: Kind.Win,
    externalTransactionId: randomUUID(),
  };
  delete win.referenceExternalTransactionId;
  await submit.execute(win, randomUUID());
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(
      `${await app.getUrl()}/wagering/transactions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': pending.key,
        },
        body: JSON.stringify(pending.input),
      },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      status: 'FAILED',
      idempotentReplay: true,
      balance: { amount: '90.00' },
      failureCode: 'PERSISTENCE_INTEGRITY_FAILURE',
    });
    await assertConsistent(pending.input.walletId, '100.00');
  } finally {
    await app.close();
    if (previous === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous;
    }
  }
});
