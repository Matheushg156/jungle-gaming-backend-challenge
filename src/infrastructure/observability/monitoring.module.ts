import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { HealthController } from '../../http/health.controller';
import { MetricsController } from '../../http/metrics.controller';
import { PersistenceModule } from '../persistence/persistence.module';
import { HealthService } from '../health/health.service';
import { createLocalSqsClient } from '../messaging/sqs-event.publisher';
import { ObservabilityModule } from './observability.module';

@Module({
  imports: [PersistenceModule, ObservabilityModule],
  controllers: [HealthController, MetricsController],
  providers: [
    {
      provide: HealthService,
      useFactory: (orm: MikroORM) =>
        new HealthService(orm, createLocalSqsClient(), [
          process.env.SQS_TRANSACTIONS_QUEUE_URL ??
            'http://localhost:4566/queue/us-east-1/000000000000/wager-transactions.fifo',
          process.env.SQS_TRANSACTIONS_DLQ_URL ??
            'http://localhost:4566/queue/us-east-1/000000000000/wager-transactions-dlq.fifo',
          process.env.SQS_EVENTS_QUEUE_URL ??
            'http://localhost:4566/queue/us-east-1/000000000000/wager-events.fifo',
        ]),
      inject: [MikroORM],
    },
  ],
})
export class MonitoringModule {}
