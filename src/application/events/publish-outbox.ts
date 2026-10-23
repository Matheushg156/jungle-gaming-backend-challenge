import type { ProcessingObserver } from '../ports/processing-observer';
import { OutboxRepository } from '../ports/outbox.repository';
import { IntegrationEventPublisher } from '../ports/integration-event-publisher';

export class PublishOutbox {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly publisher: IntegrationEventPublisher,
    private readonly observer?: ProcessingObserver,
  ) {}

  async execute(
    now = new Date(),
    limit = 10,
  ): Promise<{ published: number; retried: number }> {
    const result = { published: 0, retried: 0 };
    for (let index = 0; index < limit; index += 1) {
      let published = false;
      let identifiers:
        | { correlationId: string; messageId: string; walletId: string }
        | undefined;
      const found = await this.outbox.withNextDue(now, async (message) => {
        identifiers = {
          correlationId: message.payload.correlationId,
          messageId: message.id,
          walletId: message.aggregateId,
        };
        try {
          await this.publisher.publish(message.payload);
        } catch {
          message.scheduleRetry(now);
          return;
        }
        message.markPublished(new Date());
        published = true;
      });
      if (!found) {
        break;
      }
      // Count only after the repository confirms the publication transaction.
      this.observer?.record({
        event: published ? 'outbox_published' : 'outbox_retry',
        ...identifiers,
      });
      if (published) {
        result.published += 1;
      } else {
        result.retried += 1;
      }
    }
    return result;
  }
}
