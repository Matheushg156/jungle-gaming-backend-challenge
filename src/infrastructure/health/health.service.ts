import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

export class HealthService {
  constructor(
    private readonly orm: MikroORM,
    private readonly client: SQSClient,
    private readonly queueUrls: readonly string[],
  ) {}

  async readiness() {
    const results = await Promise.allSettled([
      this.withDeadline(
        this.orm.em.fork().transactional(async (em) => {
          await em.execute("set local statement_timeout = '2s'");
          await em.execute('select 1');
        }),
      ),
      this.withDeadline(
        Promise.all(
          this.queueUrls.map((QueueUrl) =>
            this.client.send(
              new GetQueueAttributesCommand({
                QueueUrl,
                AttributeNames: ['QueueArn'],
              }),
            ),
          ),
        ),
      ),
    ]);
    const postgres = results[0]?.status === 'fulfilled' ? 'up' : 'down';
    const sqs = results[1]?.status === 'fulfilled' ? 'up' : 'down';
    return {
      status: postgres === 'up' && sqs === 'up' ? 'ok' : 'unavailable',
      checks: { postgres, sqs },
    };
  }

  private async withDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Health dependency timeout')),
            2500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
