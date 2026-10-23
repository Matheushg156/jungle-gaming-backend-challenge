import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PublishOutbox } from '../../application/events/publish-outbox';

@Injectable()
export class OutboxPublisherWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(@Inject(PublishOutbox) private readonly publish: PublishOutbox) {}

  onApplicationBootstrap(): void {
    const enabled = process.env.OUTBOX_PUBLISHER_ENABLED ?? 'true';
    if (enabled !== 'true' && enabled !== 'false') {
      throw new Error('OUTBOX_PUBLISHER_ENABLED must be true or false');
    }
    if (enabled === 'false') {
      return;
    }
    this.timer = setInterval(() => {
      this.tick();
    }, 1000);
  }

  private tick(): void {
    if (this.inFlight) {
      return;
    }
    this.inFlight = this.publish
      .execute()
      .then(({ retried }) => {
        if (retried) {
          this.logger.warn({
            code: 'OUTBOX_PUBLICATION_RETRY',
            count: retried,
          });
        }
      })
      .catch(() => {
        this.logger.error({
          code: 'OUTBOX_DATABASE_RETRY',
          message: 'Outbox batch failed; will retry on next tick',
        });
      })
      .finally(() => {
        this.inFlight = undefined;
      });
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.inFlight;
  }
}
