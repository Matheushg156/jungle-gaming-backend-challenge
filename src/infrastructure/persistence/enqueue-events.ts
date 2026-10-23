import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/entities/outbox-message';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import { toOutboxRecord } from './mappers/outbox-message.mapper';
import { OutboxMessageSchema } from './schemas/outbox-message.schema';

export function enqueueEvents(
  em: EntityManager,
  events: readonly IntegrationEvent<object>[],
): void {
  for (const event of events) {
    em.create(
      OutboxMessageSchema,
      toOutboxRecord(OutboxMessage.enqueue(event)),
    );
  }
}
