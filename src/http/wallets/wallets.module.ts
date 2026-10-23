import { Module } from '@nestjs/common';
import { WalletRepository } from '../../application/ports/wallet.repository';
import { OpenWallet } from '../../application/wallets/open-wallet';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { AuthModule } from '../../infrastructure/auth/auth.module';
import { WalletsController } from './wallets.controller';
import { ListWalletLedger } from '../../application/wallets/list-wallet-ledger';
import { ReconcileWallet } from '../../application/wallets/reconcile-wallet';
import { WalletReadRepository } from '../../application/ports/wallet-read.repository';
import { ReconciliationObserver } from '../../application/ports/reconciliation-observer';
import { ObservabilityModule } from '../../infrastructure/observability/observability.module';

@Module({
  imports: [AuthModule, PersistenceModule, ObservabilityModule],
  controllers: [WalletsController],
  providers: [
    {
      provide: ListWalletLedger,
      useFactory: (wallets: WalletReadRepository) =>
        new ListWalletLedger(wallets),
      inject: [WalletReadRepository],
    },
    {
      provide: ReconcileWallet,
      useFactory: (
        wallets: WalletReadRepository,
        observer: ReconciliationObserver,
      ) => new ReconcileWallet(wallets, observer),
      inject: [WalletReadRepository, ReconciliationObserver],
    },
    {
      provide: OpenWallet,
      useFactory: (wallets: WalletRepository) => new OpenWallet(wallets),
      inject: [WalletRepository],
    },
  ],
})
export class WalletsModule {}
