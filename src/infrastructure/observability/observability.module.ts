import { Module } from '@nestjs/common';
import { ReconciliationObserver } from '../../application/ports/reconciliation-observer';
import { MetricsController } from '../../http/metrics.controller';
import { ApplicationMetrics } from './application-metrics';

@Module({
  controllers: [MetricsController],
  providers: [
    ApplicationMetrics,
    { provide: ReconciliationObserver, useExisting: ApplicationMetrics },
  ],
  exports: [ReconciliationObserver],
})
export class ObservabilityModule {}
