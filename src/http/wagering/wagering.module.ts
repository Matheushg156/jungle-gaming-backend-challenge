import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { WagerProcessingModule } from '../../infrastructure/wagering.module';
import { AuthModule } from '../../infrastructure/auth/auth.module';
import { WageringController } from './wagering.controller';
import { ProviderTransactionsController } from './provider-transactions.controller';

@Module({
  imports: [AuthModule, PersistenceModule, WagerProcessingModule],
  controllers: [WageringController, ProviderTransactionsController],
  providers: [],
})
export class WageringModule {}
