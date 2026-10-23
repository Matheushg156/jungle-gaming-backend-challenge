import { Module } from '@nestjs/common';
import { WageringUnitOfWork } from '../../application/ports/wagering-unit-of-work';
import { SubmitWager } from '../../application/wagering/submit-wager';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { ProviderIdentityGuard } from '../provider-identity.guard';
import { WageringController } from './wagering.controller';
import { RetryPendingReferences } from '../../application/wagering/retry-pending-references';
import { ReferenceRecoveryWorker } from '../../infrastructure/workers/reference-recovery.worker';
import { ProviderTransactionsController } from './provider-transactions.controller';

@Module({
  imports: [PersistenceModule],
  controllers: [WageringController, ProviderTransactionsController],
  providers: [
    ProviderIdentityGuard,
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
export class WageringModule {}
