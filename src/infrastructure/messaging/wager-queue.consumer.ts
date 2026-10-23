import type { ProcessingObserver } from '../../application/ports/processing-observer';
import { createHash } from 'node:crypto';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { SubmitWager } from '../../application/wagering/submit-wager';
import { DomainError } from '../../domain/errors/domain-error';
import { InvalidQueueMessage, parseWagerMessage } from './parse-wager-message';

export const WAGER_CONSUMER_NAME = 'wager-transactions-v1';

export function classifyQueueError(error: unknown): {
  permanent: boolean;
  code: string;
} {
  if (error instanceof DomainError || error instanceof InvalidQueueMessage) {
    return { permanent: true, code: error.code };
  }
  // Integrity errors cannot be repaired by retrying the same payload.
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^23\d{3}$/.test(error.code)
  ) {
    return { permanent: true, code: 'PERSISTENCE_CONSTRAINT_FAILURE' };
  }
  return { permanent: false, code: 'TRANSIENT_PROCESSING_FAILURE' };
}

export function retryVisibilitySeconds(attempt: number): number {
  return Math.min(30, 2 ** Math.min(Math.max(attempt - 1, 0), 5));
}

interface ConsumerOptions {
  waitTimeSeconds?: number;
  visibilitySeconds?: number;
  maxAttempts?: number;
}

export class WagerQueueConsumer {
  private readonly waitTimeSeconds: number;
  private readonly visibilitySeconds: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly dlqUrl: string,
    private readonly submit: SubmitWager,
    options: ConsumerOptions = {},
    private readonly observer?: ProcessingObserver,
  ) {
    this.waitTimeSeconds = options.waitTimeSeconds ?? 2;
    this.visibilitySeconds = options.visibilitySeconds ?? 60;
    this.maxAttempts = options.maxAttempts ?? 5;
    if (
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 5
    ) {
      throw new Error('Consumer maxAttempts must be between 1 and 5');
    }
  }

  async processNext(signal?: AbortSignal) {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.waitTimeSeconds,
        VisibilityTimeout: this.visibilitySeconds,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
      signal ? { abortSignal: signal } : {},
    );
    const message = response.Messages?.[0];
    if (!message) {
      return { outcome: 'EMPTY' as const };
    }
    const receipt = message.ReceiptHandle;
    if (!receipt) {
      throw new Error('SQS message has no receipt handle');
    }
    const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let failure: ReturnType<typeof classifyQueueError> | undefined;
    let identifiers:
      | {
          messageId: string;
          correlationId: string;
          walletId: string;
          providerId: string;
          transactionId: string;
        }
      | undefined;
    try {
      const parsed = parseWagerMessage(message.Body ?? '');
      const result = await this.submit.execute(
        parsed.input,
        parsed.idempotencyKey,
        {
          correlationId: parsed.correlationId,
          causationId: parsed.messageId,
          inbox: {
            consumerName: WAGER_CONSUMER_NAME,
            messageId: parsed.messageId,
            payloadHash: parsed.payloadHash,
            receivedAt: new Date(),
          },
        },
      );
      identifiers = {
        messageId: parsed.messageId,
        correlationId: parsed.correlationId,
        walletId: parsed.input.walletId,
        providerId: parsed.input.providerId,
        transactionId: result.transactionId,
      };
    } catch (error: unknown) {
      failure = classifyQueueError(error);
    }
    // Transport failures here must not be mistaken for failed financial processing.
    // A failed ack leaves the committed inbox available to the next delivery.
    if (!failure) {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receipt,
        }),
      );
      return { outcome: 'ACKNOWLEDGED' as const, ...identifiers };
    }
    if (!failure.permanent && attempts < this.maxAttempts) {
      const delay = retryVisibilitySeconds(attempts);
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receipt,
          VisibilityTimeout: delay,
        }),
      );
      this.observer?.record({
        event: 'queue_retry',
        code: failure.code,
        messageId: message.MessageId ?? 'unknown',
      });
      return {
        outcome: 'RETRY' as const,
        brokerMessageId: message.MessageId,
        code: failure.code,
        attempts,
        delay,
      };
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId:
          message.Attributes?.MessageGroupId ?? message.MessageId ?? 'invalid',
        MessageDeduplicationId: createHash('sha256')
          .update(`${this.queueUrl}:${message.MessageId}`)
          .digest('hex'),
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: failure.code },
          receiveCount: { DataType: 'Number', StringValue: String(attempts) },
          consumerName: {
            DataType: 'String',
            StringValue: WAGER_CONSUMER_NAME,
          },
          sourceMessageId: {
            DataType: 'String',
            StringValue: message.MessageId ?? 'unknown',
          },
        },
      }),
    );
    this.observer?.record({
      event: 'queue_dead_lettered',
      code: failure.code,
      messageId: message.MessageId ?? 'unknown',
    });
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receipt,
      }),
    );
    return {
      outcome: 'DEAD_LETTERED' as const,
      brokerMessageId: message.MessageId,
      code: failure.code,
      attempts,
    };
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
