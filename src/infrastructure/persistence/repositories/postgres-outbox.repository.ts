import { IsolationLevel, LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../../../application/ports/outbox.repository';
import type { OutboxMessage } from '../../../domain/entities/outbox-message';
import { rehydrateOutbox } from '../mappers/outbox-message.mapper';
import { OutboxMessageSchema } from '../schemas/outbox-message.schema';

export class PostgresOutboxRepository extends OutboxRepository {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  override async withNextDue(
    now: Date,
    action: (message: OutboxMessage) => Promise<void>,
  ): Promise<boolean> {
    return this.orm.em.fork().transactional(
      async (em) => {
        const record = await em.findOne(
          OutboxMessageSchema,
          {
            publishedAt: null,
            $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
          },
          {
            orderBy: { occurredAt: 'asc', id: 'asc' },
            lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
          },
        );
        if (!record) {
          return false;
        }
        const message = rehydrateOutbox(record);
        await action(message);
        record.attempts = message.attempts;
        record.nextAttemptAt = message.nextAttemptAt ?? null;
        record.publishedAt = message.publishedAt ?? null;
        await em.flush();
        return true;
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
  }
}
