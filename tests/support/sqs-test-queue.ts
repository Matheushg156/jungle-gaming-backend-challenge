import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import type { EventEnvelope } from '../../src/domain/events/integration-event';
import {
  createLocalSqsClient,
  SqsEventPublisher,
} from '../../src/infrastructure/messaging/sqs-event.publisher';

export async function createTestQueue() {
  const endpoint = process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4567';
  const client = createLocalSqsClient(endpoint);
  try {
    const response = await client.send(
      new CreateQueueCommand({
        QueueName: `outbox-test-${randomUUID()}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    if (!response.QueueUrl) {
      throw new Error('SQS did not return a queue URL');
    }
    const url = new URL(response.QueueUrl);
    const endpointUrl = new URL(endpoint);
    url.host = endpointUrl.host;
    url.protocol = endpointUrl.protocol;
    const queueUrl = url.toString();
    return {
      client,
      queueUrl,
      publisher: new SqsEventPublisher(client, queueUrl),
      async receiveAll(expected: number): Promise<EventEnvelope[]> {
        const events: EventEnvelope[] = [];
        for (
          let attempt = 0;
          attempt < 20 && events.length < expected;
          attempt += 1
        ) {
          const batch = await client.send(
            new ReceiveMessageCommand({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 0,
            }),
          );
          for (const message of batch.Messages ?? []) {
            if (!message.Body || !message.ReceiptHandle) {
              throw new Error('Invalid received SQS message');
            }
            events.push(JSON.parse(message.Body) as EventEnvelope);
            await client.send(
              new DeleteMessageCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            );
          }
          if (events.length < expected) {
            await Bun.sleep(25);
          }
        }
        return events;
      },
      async close(): Promise<void> {
        try {
          await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        } finally {
          client.destroy();
        }
      },
    };
  } catch (error: unknown) {
    client.destroy();
    throw error;
  }
}
