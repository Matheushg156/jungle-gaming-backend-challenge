import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/domain/value-objects/money';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransactionProps,
} from '../../../../src/domain/entities/wager-transaction';
import { LedgerDirection } from '../../../../src/domain/entities/wallet-ledger-entry';

const at = new Date('2026-01-01T00:00:00.000Z');
const createTransactionProps = (
  kind: Kind,
  overrides: Partial<WagerTransactionProps> = {},
): WagerTransactionProps => ({
  id: 'transaction',
  providerId: 'provider',
  externalTransactionId: 'external',
  idempotencyKey: 'provider:external',
  payloadHash: 'hash',
  walletId: 'wallet',
  playerId: 'player',
  roundId: 'round',
  gameId: 'game',
  kind,
  money: Money.from({
    amount: kind === Kind.Loss ? '0.00' : '10.00',
    currency: 'BRL',
  }),
  createdAt: at,
  ...overrides,
});
const createProcessedTransaction = (kind: Kind): WagerTransaction => {
  const transaction = WagerTransaction.create(
    createTransactionProps(kind, {
      id: 'reference',
      externalTransactionId: 'original',
      ...(kind === Kind.Refund
        ? { referenceExternalTransactionId: 'bet' }
        : {}),
    }),
  );
  transaction.markProcessed(kind === Kind.Refund ? 'bet-id' : undefined, at);
  return transaction;
};

describe('WagerTransaction', () => {
  test('BET debits, WIN credits and LOSS has no ledger effect', () => {
    expect(
      WagerTransaction.create(
        createTransactionProps(Kind.Bet),
      ).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Debit);
    expect(
      WagerTransaction.create(
        createTransactionProps(Kind.Win),
      ).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    const loss = WagerTransaction.create(createTransactionProps(Kind.Loss));
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow('does not produce');
  });

  test('OPENING is restricted to the internal factory', () => {
    expect(() =>
      WagerTransaction.create(createTransactionProps(Kind.Opening)),
    ).toThrow('internal factory');
    expect(
      WagerTransaction.opening(
        createTransactionProps(Kind.Opening),
      ).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expect(() => WagerTransaction.create(createTransactionProps(kind))).toThrow(
      'require a reference',
    );
  });

  test('refund credits a processed bet and rejects partial reversal', () => {
    const refund = WagerTransaction.create(
      createTransactionProps(Kind.Refund, {
        referenceExternalTransactionId: 'original',
      }),
    );
    expect(
      refund.ledgerDirectionFor(createProcessedTransaction(Kind.Bet)),
    ).toBe(LedgerDirection.Credit);
    const partial = WagerTransaction.create(
      createTransactionProps(Kind.Refund, {
        referenceExternalTransactionId: 'original',
        money: Money.from({ amount: '5.00', currency: 'BRL' }),
      }),
    );
    expect(() =>
      partial.validateReference(createProcessedTransaction(Kind.Bet)),
    ).toThrow('Partial reversals');
    expect(() =>
      refund.validateReference(createProcessedTransaction(Kind.Win)),
    ).toThrow('cannot reference this kind');
  });

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ] as const)('rollback inverts %s', (kind, direction) => {
    const rollback = WagerTransaction.create(
      createTransactionProps(Kind.Rollback, {
        referenceExternalTransactionId: 'original',
      }),
    );
    expect(rollback.ledgerDirectionFor(createProcessedTransaction(kind))).toBe(
      direction,
    );
  });

  test.each([
    'providerId',
    'playerId',
    'walletId',
    'roundId',
    'referenceExternalTransactionId',
  ] as const)('rejects reference mismatch in %s', (field) => {
    const refund = WagerTransaction.create(
      createTransactionProps(Kind.Refund, {
        referenceExternalTransactionId: 'original',
        [field]: 'different',
      }),
    );
    expect(() =>
      refund.validateReference(createProcessedTransaction(Kind.Bet)),
    ).toThrow('same provider');
  });

  test('rejects a reference in another currency or not yet processed', () => {
    const refund = WagerTransaction.create(
      createTransactionProps(Kind.Refund, {
        referenceExternalTransactionId: 'original',
      }),
    );
    const pending = WagerTransaction.create(
      createTransactionProps(Kind.Bet, {
        id: 'reference',
        externalTransactionId: 'original',
      }),
    );
    expect(() => refund.validateReference(pending)).toThrow(
      'must be processed',
    );
    const usd = WagerTransaction.create(
      createTransactionProps(Kind.Bet, {
        id: 'reference',
        externalTransactionId: 'original',
        money: Money.from({ amount: '10.00', currency: 'USD' }),
      }),
    );
    usd.markProcessed(undefined, at);
    expect(() => refund.validateReference(usd)).toThrow('same provider');
  });

  test('moves from pending reference to processed after resolution', () => {
    const refund = WagerTransaction.create(
      createTransactionProps(Kind.Refund, {
        referenceExternalTransactionId: 'original',
      }),
    );
    expect(refund.status).toBe(Status.Pending);
    refund.markPendingReference();
    expect(refund.status).toBe(Status.PendingReference);
    expect(() => refund.markProcessed(undefined, at)).toThrow('resolved');
    refund.markProcessed('reference', at);
    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe('reference');
    expect(refund.processedAt).toEqual(at);
  });

  test.each([Status.Processed, Status.Rejected, Status.Failed])(
    'prevents all transitions from terminal state %s',
    (status) => {
      const transaction = WagerTransaction.create(
        createTransactionProps(Kind.Bet),
      );
      if (status === Status.Processed) {
        transaction.markProcessed(undefined, at);
      } else if (status === Status.Rejected) {
        transaction.reject('INSUFFICIENT_FUNDS');
      } else {
        transaction.fail('PERMANENT_INFRASTRUCTURE_FAILURE');
      }
      expect(transaction.isTerminal()).toBe(true);
      expect(() => transaction.markProcessed(undefined, at)).toThrow(
        'Terminal',
      );
      expect(() => transaction.markPendingReference()).toThrow('Terminal');
      expect(() => transaction.reject('OTHER')).toThrow('Terminal');
      expect(() => transaction.fail('OTHER')).toThrow('Terminal');
    },
  );

  test('distinguishes identical payload from idempotency conflict', () => {
    const transaction = WagerTransaction.create(
      createTransactionProps(Kind.Bet),
    );
    expect(transaction.matchesPayload('hash')).toBe(true);
    expect(() => transaction.assertReplay('hash')).not.toThrow();
    expect(() => transaction.assertReplay('different')).toThrow(
      'different payload',
    );
  });

  test('rejects zero financial operations and nonzero LOSS', () => {
    expect(() =>
      WagerTransaction.create(
        createTransactionProps(Kind.Bet, { money: Money.zero('BRL') }),
      ),
    ).toThrow('positive amount');
    expect(() =>
      WagerTransaction.create(
        createTransactionProps(Kind.Loss, {
          money: Money.from({ amount: '1.00', currency: 'BRL' }),
        }),
      ),
    ).toThrow('must be zero');
  });

  test('rehydrates terminal state without replaying transitions', () => {
    const transaction = WagerTransaction.rehydrate({
      ...createTransactionProps(Kind.Bet),
      status: Status.Rejected,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
  });
});
