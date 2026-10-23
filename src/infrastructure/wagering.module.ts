import { ProcessingObserver } from '../application/ports/processing-observer';
import { ObservabilityModule } from './observability/observability.module';
import { Module } from '@nestjs/common';
import { WageringUnitOfWork } from '../application/ports/wagering-unit-of-work';
import { SubmitWager } from '../application/wagering/submit-wager';
import { RetryPendingReferences } from '../application/wagering/retry-pending-references';
import { PersistenceModule } from './persistence/persistence.module';
import { ReferenceRecoveryWorker } from './workers/reference-recovery.worker';

@Module({
  imports: [PersistenceModule, ObservabilityModule],
  exports: [SubmitWager],
  providers: [
    ReferenceRecoveryWorker,
    {
      provide: RetryPendingReferences,
      useFactory: (
        unitOfWork: WageringUnitOfWork,
        observer: ProcessingObserver,
      ) => new RetryPendingReferences(unitOfWork, observer),
      inject: [WageringUnitOfWork, ProcessingObserver],
    },
    {
      provide: SubmitWager,
      useFactory: (
        unitOfWork: WageringUnitOfWork,
        observer: ProcessingObserver,
      ) => new SubmitWager(unitOfWork, observer),
      inject: [WageringUnitOfWork, ProcessingObserver],
    },
  ],
})
export class WagerProcessingModule {}
