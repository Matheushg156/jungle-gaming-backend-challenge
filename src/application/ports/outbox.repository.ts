import type { OutboxMessage } from '../../domain/entities/outbox-message';

export abstract class OutboxRepository {
  abstract withNextDue(
    now: Date,
    action: (message: OutboxMessage) => Promise<void>,
  ): Promise<boolean>;
}
