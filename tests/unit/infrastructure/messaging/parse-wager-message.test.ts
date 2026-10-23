import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { parseWagerMessage } from '../../../../src/infrastructure/messaging/parse-wager-message';
import {
  classifyQueueError,
  retryVisibilitySeconds,
} from '../../../../src/infrastructure/messaging/wager-queue.consumer';
import { DomainError } from '../../../../src/domain/errors/domain-error';

const message = {
  messageId: 'msg-1',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-10-23T00:00:00.000Z',
  data: {
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    playerId: randomUUID(),
    walletId: randomUUID(),
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
  },
};

describe('Queue message contract', () => {
  test('canonical hash ignores transport metadata but binds the idempotency key', () => {
    const parse = (value: unknown) => parseWagerMessage(JSON.stringify(value));
    const original = parse(message);
    expect(
      parse({
        ...message,
        messageId: 'msg-2',
        correlationId: 'corr',
        occurredAt: '2026-10-24T00:00:00.000Z',
      }).payloadHash,
    ).toBe(original.payloadHash);
    expect(
      parse({ ...message, data: { ...message.data, idempotencyKey: 'other' } })
        .payloadHash,
    ).not.toBe(original.payloadHash);
  });

  test.each(
    [
      null,
      [],
      {},
      { ...message, data: [] },
      { ...message, data: { ...message.data, money: [] } },
      { ...message, data: { ...message.data, kind: 'OPENING' } },
      { ...message, data: { ...message.data, providerId: '__internal__' } },
      {
        ...message,
        data: { ...message.data, money: { amount: 10, currency: 'BRL' } },
      },
      { ...message, data: { ...message.data, idempotencyKey: '' } },
      { ...message, extra: 'unexpected' },
      { ...message, occurredAt: 'invalid' },
    ].map((value) => ({ value })),
  )('rejects malformed or forbidden input %#', ({ value }) => {
    expect(() => parseWagerMessage(JSON.stringify(value))).toThrow(
      'Invalid wagering message',
    );
  });

  test('classification keeps domain conflicts permanent and unknown failures retryable', () => {
    expect(classifyQueueError(new DomainError('CONFLICT', 'conflict'))).toEqual(
      { permanent: true, code: 'CONFLICT' },
    );
    expect(classifyQueueError({ code: '23514' }).permanent).toBe(true);
    expect(classifyQueueError({ code: '40001' }).permanent).toBe(false);
    expect(classifyQueueError(new Error('network')).permanent).toBe(false);
    expect([1, 2, 3, 4, 5, 6, 20].map(retryVisibilitySeconds)).toEqual([
      1, 2, 4, 8, 16, 30, 30,
    ]);
  });
});
