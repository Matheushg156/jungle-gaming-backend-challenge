import { Module } from '@nestjs/common';
import { WageringUnitOfWork } from '../application/ports/wagering-unit-of-work';
import { SubmitWager } from '../application/wagering/submit-wager';
import { RetryPendingReferences } from '../application/wagering/retry-pending-references';
import { PersistenceModule } from './persistence/persistence.module';
import { ReferenceRecoveryWorker } from './workers/reference-recovery.worker';

@Module({
  imports: [PersistenceModule],
  exports: [SubmitWager],
  providers: [
    ReferenceRecoveryWorker,
    {
      provide: RetryPendingReferences,
      useFactory: (unitOfWork: WageringUnitOfWork) =>
        new RetryPendingReferences(unitOfWork),
      inject: [WageringUnitOfWork],
    },
    {
      provide: SubmitWager,
      useFactory: (unitOfWork: WageringUnitOfWork) =>
        new SubmitWager(unitOfWork),
      inject: [WageringUnitOfWork],
    },
  ],
})
export class WagerProcessingModule {}
