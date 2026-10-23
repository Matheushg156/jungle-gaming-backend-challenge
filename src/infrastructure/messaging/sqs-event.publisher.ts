import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { IntegrationEventPublisher } from '../../application/ports/integration-event-publisher';
import type { EventEnvelope } from '../../domain/events/integration-event';

export function createLocalSqsClient(
  endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
  });
}

export class SqsEventPublisher extends IntegrationEventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }

  override async publish(event: EventEnvelope): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(event),
        MessageGroupId: event.aggregateId,
        MessageDeduplicationId: event.eventId,
      }),
    );
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
