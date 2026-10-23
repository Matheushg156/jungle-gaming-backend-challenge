import { describe, expect, test } from 'bun:test';
import { OutboxMessage } from '../../../../src/domain/entities/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../../../src/domain/entities/wager-transaction';
import { Wallet } from '../../../../src/domain/entities/wallet';
import { Money } from '../../../../src/domain/value-objects/money';
import { WagerTransactionProcessed } from '../../../../src/domain/events/wager-transaction-events';

const at = new Date('2026-01-01T00:00:00.000Z');
function createEvent() {
  const wallet = Wallet.open({
    id: 'wallet',
    playerId: 'player',
    initialBalance: Money.zero('BRL'),
    at,
  });
  const transaction = WagerTransaction.create({
    id: 'transaction',
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    payloadHash: 'hash',
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind: WagerTransactionKind.Loss,
    money: Money.zero('BRL'),
    createdAt: at,
  });
  transaction.markProcessed(undefined, at);
  return WagerTransactionProcessed.from(transaction, wallet, {
    eventId: 'event',
    correlationId: 'correlation',
    causationId: 'cause',
    occurredAt: at,
  });
}

describe('Integration event and OutboxMessage', () => {
  test('serializes a versioned envelope with decimal strings and ISO dates', () => {
    const event = createEvent();
    expect(event.toJSON()).toMatchObject({
      eventId: 'event',
      eventType: 'WagerTransactionProcessed',
      version: 1,
      aggregateId: 'wallet',
      correlationId: 'correlation',
      causationId: 'cause',
      occurredAt: at.toISOString(),
      data: { money: { amount: '0.00', currency: 'BRL' } },
    });
    event.occurredAt.setFullYear(2000);
    expect(event.occurredAt).toEqual(at);
    const serialized = event.toJSON();
    serialized.data.money.amount = '99.00';
    expect(event.data.money.amount).toBe('0.00');
  });

  test('keeps the event identity and does not expose its stored payload for mutation', () => {
    const message = OutboxMessage.enqueue(createEvent());
    const payload = message.payload;
    payload.eventId = 'changed';
    expect(message.id).toBe('event');
    expect(message.payload.eventId).toBe('event');
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at)).toBe(true);
  });

  test('retries exponentially with a five-minute cap', () => {
    const message = OutboxMessage.enqueue(createEvent());
    message.scheduleRetry(at);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.getTime()).toBe(at.getTime() + 1000);
    expect(message.isDue(at)).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 1000))).toBe(true);
    message.scheduleRetry(at);
    expect(message.nextAttemptAt?.getTime()).toBe(at.getTime() + 2000);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      message.scheduleRetry(at);
    }
    expect(message.nextAttemptAt?.getTime()).toBe(at.getTime() + 300000);
  });

  test('published messages are terminal and not due', () => {
    const message = OutboxMessage.enqueue(createEvent());
    message.scheduleRetry(at);
    message.markPublished(at);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(at)).toBe(false);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(() => message.markPublished(at)).toThrow('cannot change');
    expect(() => message.scheduleRetry(at)).toThrow('cannot change');
  });

  test('rehydrates retry state without changing attempts or timestamps', () => {
    const event = createEvent();
    const message = OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: at,
      attempts: 3,
      nextAttemptAt: new Date(at.getTime() + 4000),
    });
    expect(message.attempts).toBe(3);
    expect(message.nextAttemptAt?.getTime()).toBe(at.getTime() + 4000);
  });
});
