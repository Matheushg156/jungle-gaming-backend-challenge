import { Module } from '@nestjs/common';
import { WageringUnitOfWork } from '../../application/ports/wagering-unit-of-work';
import { SubmitWager } from '../../application/wagering/submit-wager';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { ProviderIdentityGuard } from '../provider-identity.guard';
import { WageringController } from './wagering.controller';

@Module({
  imports: [PersistenceModule],
  controllers: [WageringController],
  providers: [
    ProviderIdentityGuard,
    {
      provide: SubmitWager,
      useFactory: (unitOfWork: WageringUnitOfWork) =>
        new SubmitWager(unitOfWork),
      inject: [WageringUnitOfWork],
    },
  ],
})
export class WageringModule {}
