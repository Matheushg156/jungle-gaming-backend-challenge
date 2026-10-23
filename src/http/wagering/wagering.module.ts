import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { WagerProcessingModule } from '../../infrastructure/wagering.module';
import { ProviderIdentityGuard } from '../provider-identity.guard';
import { WageringController } from './wagering.controller';
import { ProviderTransactionsController } from './provider-transactions.controller';

@Module({
  imports: [PersistenceModule, WagerProcessingModule],
  controllers: [WageringController, ProviderTransactionsController],
  providers: [ProviderIdentityGuard],
})
export class WageringModule {}
