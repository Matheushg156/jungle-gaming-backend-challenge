import { ProcessingObserver } from '../../application/ports/processing-observer';
import { ObservabilityModule } from '../observability/observability.module';
import { Module } from '@nestjs/common';
import { SubmitWager } from '../../application/wagering/submit-wager';
import { WagerProcessingModule } from '../wagering.module';
import { WagerConsumerWorker } from '../workers/wager-consumer.worker';
import { createLocalSqsClient } from './sqs-event.publisher';
import { WagerQueueConsumer } from './wager-queue.consumer';

@Module({
  imports: [WagerProcessingModule, ObservabilityModule],
  providers: [
    WagerConsumerWorker,
    {
      provide: WagerQueueConsumer,
      useFactory: (submit: SubmitWager, observer: ProcessingObserver) =>
        new WagerQueueConsumer(
          createLocalSqsClient(),
          process.env.SQS_TRANSACTIONS_QUEUE_URL ??
            'http://localhost:4566/queue/us-east-1/000000000000/wager-transactions.fifo',
          process.env.SQS_TRANSACTIONS_DLQ_URL ??
            'http://localhost:4566/queue/us-east-1/000000000000/wager-transactions-dlq.fifo',
          submit,
          {},
          observer,
        ),
      inject: [SubmitWager, ProcessingObserver],
    },
  ],
})
export class ConsumerModule {}
