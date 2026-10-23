import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/domain/value-objects/money';
import { Wallet } from '../../../../src/domain/entities/wallet';
import { LedgerDirection } from '../../../../src/domain/entities/wallet-ledger-entry';

const createBrl = (amount: string): Money =>
  Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00.000Z');
const createWallet = (): Wallet =>
  Wallet.open({
    id: 'wallet',
    playerId: 'player',
    initialBalance: createBrl('100.00'),
    at,
  });
const createMovement = (amount: string) => ({
  ledgerEntryId: 'entry',
  transactionId: 'transaction',
  money: createBrl(amount),
  at,
});

describe('Wallet', () => {
  test('opens at version one and rejects a negative initial balance', () => {
    expect(createWallet().version).toBe(1);
    expect(() =>
      Wallet.open({
        id: 'wallet',
        playerId: 'player',
        initialBalance: createBrl('1.00').negate(),
        at,
      }),
    ).toThrow('non-negative');
  });

  test('debits and credits with matching balanced ledger entries', () => {
    const wallet = createWallet();
    const debit = wallet.debit(createMovement('80.00'));
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(debit.direction).toBe(LedgerDirection.Debit);
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(debit.isBalanced()).toBe(true);
    const credit = wallet.credit(createMovement('5.00'));
    expect(wallet.balance.toString()).toBe('25.00');
    expect(wallet.version).toBe(3);
    expect(credit.direction).toBe(LedgerDirection.Credit);
    expect(credit.isBalanced()).toBe(true);
  });

  test('allows spending the exact balance and leaves state unchanged after rejection', () => {
    const wallet = createWallet();
    wallet.debit(createMovement('100.00'));
    expect(wallet.balance.isZero()).toBe(true);
    expect(() => wallet.debit(createMovement('0.01'))).toThrow(
      'insufficient funds',
    );
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test('rejects zero, negative and mixed currency movements without changing state', () => {
    const wallet = createWallet();
    for (const money of [
      createBrl('0.00'),
      createBrl('1.00').negate(),
      Money.from({ amount: '1.00', currency: 'USD' }),
    ]) {
      expect(() =>
        wallet.credit({ ...createMovement('1.00'), money }),
      ).toThrow();
      expect(() =>
        wallet.debit({ ...createMovement('1.00'), money }),
      ).toThrow();
    }
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  test('rehydrates without applying movements or incrementing version', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet',
      playerId: 'player',
      currency: 'BRL',
      balance: createBrl('20.00'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.toString()).toBe('20.00');
  });

  test('protects timestamps and ledger state from external mutation', () => {
    const wallet = createWallet();
    const entry = wallet.credit(createMovement('1.00'));
    wallet.createdAt.setFullYear(2000);
    entry.createdAt.setFullYear(2000);
    expect(wallet.createdAt.toISOString()).toBe(at.toISOString());
    expect(entry.createdAt.toISOString()).toBe(at.toISOString());
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
