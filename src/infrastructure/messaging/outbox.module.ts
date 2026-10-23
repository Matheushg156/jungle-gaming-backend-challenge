import { Module } from '@nestjs/common';
import { PublishOutbox } from '../../application/events/publish-outbox';
import { OutboxRepository } from '../../application/ports/outbox.repository';
import { IntegrationEventPublisher } from '../../application/ports/integration-event-publisher';
import { PersistenceModule } from '../persistence/persistence.module';
import { OutboxPublisherWorker } from '../workers/outbox-publisher.worker';
import { createLocalSqsClient, SqsEventPublisher } from './sqs-event.publisher';

@Module({
  imports: [PersistenceModule],
  providers: [
    OutboxPublisherWorker,
    {
      provide: IntegrationEventPublisher,
      useFactory: () =>
        new SqsEventPublisher(
          createLocalSqsClient(),
          process.env.SQS_EVENTS_QUEUE_URL ??
            'http://localhost:4566/queue/us-east-1/000000000000/wager-events.fifo',
        ),
    },
    {
      provide: PublishOutbox,
      useFactory: (
        outbox: OutboxRepository,
        publisher: IntegrationEventPublisher,
      ) => new PublishOutbox(outbox, publisher),
      inject: [OutboxRepository, IntegrationEventPublisher],
    },
  ],
})
export class OutboxModule {}
