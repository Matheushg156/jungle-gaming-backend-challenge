import { Module } from '@nestjs/common';
import { WalletRepository } from '../../application/ports/wallet.repository';
import { OpenWallet } from '../../application/wallets/open-wallet';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { ProviderIdentityGuard } from '../provider-identity.guard';
import { WalletsController } from './wallets.controller';

@Module({
  imports: [PersistenceModule],
  controllers: [WalletsController],
  providers: [
    ProviderIdentityGuard,
    {
      provide: OpenWallet,
      useFactory: (wallets: WalletRepository) => new OpenWallet(wallets),
      inject: [WalletRepository],
    },
  ],
})
export class WalletsModule {}
