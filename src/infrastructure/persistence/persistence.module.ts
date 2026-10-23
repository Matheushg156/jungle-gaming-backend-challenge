import { ProcessingObserver } from '../../application/ports/processing-observer';
import { ObservabilityModule } from '../observability/observability.module';
import { Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../application/ports/wallet.repository';
import { connectDatabase } from './database';
import { PostgresWalletRepository } from './repositories/postgres-wallet.repository';
import { WageringUnitOfWork } from '../../application/ports/wagering-unit-of-work';
import { PostgresWageringUnitOfWork } from './repositories/postgres-wagering-unit-of-work';
import { WalletReadRepository } from '../../application/ports/wallet-read.repository';
import { WagerReadRepository } from '../../application/ports/wager-read.repository';
import { PostgresWalletReadRepository } from './repositories/postgres-wallet-read.repository';
import { PostgresWagerReadRepository } from './repositories/postgres-wager-read.repository';
import { OutboxRepository } from '../../application/ports/outbox.repository';
import { PostgresOutboxRepository } from './repositories/postgres-outbox.repository';

@Module({
  imports: [ObservabilityModule],
  providers: [
    {
      provide: OutboxRepository,
      useFactory: (orm: MikroORM) => new PostgresOutboxRepository(orm),
      inject: [MikroORM],
    },
    {
      provide: WalletReadRepository,
      useFactory: (orm: MikroORM) => new PostgresWalletReadRepository(orm),
      inject: [MikroORM],
    },
    {
      provide: WagerReadRepository,
      useFactory: (orm: MikroORM) => new PostgresWagerReadRepository(orm),
      inject: [MikroORM],
    },
    {
      provide: WageringUnitOfWork,
      useFactory: (orm: MikroORM, observer: ProcessingObserver) =>
        new PostgresWageringUnitOfWork(orm, observer),
      inject: [MikroORM, ProcessingObserver],
    },
    { provide: MikroORM, useFactory: connectDatabase },
    {
      provide: WalletRepository,
      useFactory: (orm: MikroORM, observer: ProcessingObserver) =>
        new PostgresWalletRepository(orm, observer),
      inject: [MikroORM, ProcessingObserver],
    },
  ],
  exports: [
    MikroORM,
    OutboxRepository,
    WalletRepository,
    WageringUnitOfWork,
    WalletReadRepository,
    WagerReadRepository,
  ],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
