import { Module } from '@nestjs/common';
import { ReconciliationObserver } from '../../application/ports/reconciliation-observer';
import { ProcessingObserver } from '../../application/ports/processing-observer';
import { ApplicationMetrics } from './application-metrics';

@Module({
  providers: [
    ApplicationMetrics,
    { provide: ProcessingObserver, useExisting: ApplicationMetrics },
    { provide: ReconciliationObserver, useExisting: ApplicationMetrics },
  ],
  exports: [ReconciliationObserver, ProcessingObserver, ApplicationMetrics],
})
export class ObservabilityModule {}
