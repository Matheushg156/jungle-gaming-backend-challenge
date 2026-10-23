import { expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/domain/entities/inbox-message';

test('inbox binds immutable payload identity and has a terminal processed transition', () => {
  const receivedAt = new Date();
  const inbox = InboxMessage.receive({
    consumerName: 'consumer',
    messageId: 'message',
    payloadHash: 'a'.repeat(64),
    receivedAt,
  });
  receivedAt.setFullYear(2000);
  expect(inbox.receivedAt.getFullYear()).not.toBe(2000);
  expect(inbox.isProcessed()).toBe(false);
  expect(() => inbox.assertPayload('b'.repeat(64))).toThrow(
    'different payload',
  );
  const processedAt = new Date();
  inbox.markProcessed(processedAt);
  processedAt.setFullYear(2000);
  expect(inbox.processedAt?.getFullYear()).not.toBe(2000);
  expect(() => inbox.markProcessed(new Date())).toThrow('already processed');
});
