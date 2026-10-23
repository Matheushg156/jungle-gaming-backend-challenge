import { OutboxMessage } from '../../../domain/entities/outbox-message';
import type { OutboxMessageRecord } from '../schemas/outbox-message.schema';

export function toOutboxRecord(message: OutboxMessage): OutboxMessageRecord {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload,
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  };
}

export function rehydrateOutbox(record: OutboxMessageRecord): OutboxMessage {
  const { nextAttemptAt, publishedAt, ...state } = record;
  return OutboxMessage.rehydrate({
    ...state,
    ...(nextAttemptAt ? { nextAttemptAt } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  });
}
