import { writeOperationalLog } from '../observability/json-logger';
import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { WagerQueueConsumer } from '../messaging/wager-queue.consumer';

@Injectable()
export class WagerConsumerWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly controller = new AbortController();
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(WagerQueueConsumer) private readonly consumer: WagerQueueConsumer,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = process.env.SQS_CONSUMER_ENABLED ?? 'true';
    if (enabled !== 'true' && enabled !== 'false') {
      throw new Error('SQS_CONSUMER_ENABLED must be true or false');
    }
    if (enabled === 'true') {
      this.inFlight = this.run();
    }
  }

  private async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        const result = await this.consumer.processNext(this.controller.signal);
        if (result.outcome !== 'EMPTY') {
          writeOperationalLog('info', {
            component: 'wager-consumer',
            ...result,
          });
        }
      } catch {
        if (!this.controller.signal.aborted) {
          writeOperationalLog('warn', {
            component: 'wager-consumer',
            code: 'QUEUE_TRANSPORT_RETRY',
          });
          await Bun.sleep(1000);
        }
      }
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    // Abort only the pending receive. An already received message finishes its
    // transaction and ack/retry before persistence and SQS clients are closed.
    this.controller.abort();
    await this.inFlight;
  }
}
