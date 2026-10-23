import { describe, expect, test } from 'bun:test';
import { hashWagerPayload } from '../../../../src/application/wagering/hash-wager-payload';
import type { SubmitWagerInput } from '../../../../src/application/wagering/wager.contracts';
import { WagerTransactionKind } from '../../../../src/domain/entities/wager-transaction';

const input: SubmitWagerInput = {
  providerId: 'provider',
  externalTransactionId: 'bet-1',
  playerId: 'player',
  walletId: 'wallet',
  roundId: 'round',
  gameId: 'game',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

describe('Wager payload hash', () => {
  test('ignores the insertion order of business keys and nested money keys', () => {
    const reversed = Object.fromEntries(
      Object.entries(input).reverse(),
    ) as unknown as SubmitWagerInput;
    reversed.money = { currency: 'BRL', amount: '25.00' };
    expect(hashWagerPayload(reversed)).toBe(hashWagerPayload(input));
    expect(hashWagerPayload(input)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('excludes transport metadata and the idempotency key', () => {
    const transportInput = {
      ...input,
      idempotencyKey: 'another',
      messageId: 'message',
      correlationId: 'correlation',
    };
    expect(hashWagerPayload(transportInput)).toBe(hashWagerPayload(input));
  });

  test('changes when the amount, wallet or reference changes', () => {
    for (const changed of [
      { ...input, money: { amount: '26.00', currency: 'BRL' } },
      { ...input, walletId: 'another' },
      { ...input, referenceExternalTransactionId: 'reference' },
    ]) {
      expect(hashWagerPayload(changed)).not.toBe(hashWagerPayload(input));
    }
  });
});
