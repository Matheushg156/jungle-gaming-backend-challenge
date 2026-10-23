import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/domain/value-objects/money';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../../src/domain/entities/wallet-ledger-entry';

const createBrl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');

const createLedgerState = () => ({
  id: 'entry',
  walletId: 'wallet',
  transactionId: 'transaction',
  direction: LedgerDirection.Debit,
  money: createBrl('10.00'),
  balanceBefore: createBrl('100.00'),
  balanceAfter: createBrl('95.00'),
  createdAt: at,
});

describe('WalletLedgerEntry', () => {
  test('rejects inconsistent ledger arithmetic', () => {
    expect(() => WalletLedgerEntry.create(createLedgerState())).toThrow(
      'inconsistent',
    );
  });

  test('rejects negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...createLedgerState(),
        balanceAfter: createBrl('1.00').negate(),
      }),
    ).toThrow('non-negative');
  });

  test('rejects zero amounts', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...createLedgerState(),
        money: createBrl('0.00'),
      }),
    ).toThrow('positive');
  });
});
