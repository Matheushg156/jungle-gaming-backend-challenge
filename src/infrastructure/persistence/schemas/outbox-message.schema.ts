import { EntitySchema } from '@mikro-orm/core';
import type { EventEnvelope } from '../../../domain/events/integration-event';

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: EventEnvelope;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: { type: Date, columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: Date, columnType: 'timestamptz', nullable: true },
    publishedAt: { type: Date, columnType: 'timestamptz', nullable: true },
  },
});
