import { Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../application/ports/wallet.repository';
import { connectDatabase } from './database';
import { PostgresWalletRepository } from './repositories/postgres-wallet.repository';
import { WageringUnitOfWork } from '../../application/ports/wagering-unit-of-work';
import { PostgresWageringUnitOfWork } from './repositories/postgres-wagering-unit-of-work';

@Module({
  providers: [
    {
      provide: WageringUnitOfWork,
      useFactory: (orm: MikroORM) => new PostgresWageringUnitOfWork(orm),
      inject: [MikroORM],
    },
    { provide: MikroORM, useFactory: connectDatabase },
    {
      provide: WalletRepository,
      useFactory: (orm: MikroORM) => new PostgresWalletRepository(orm),
      inject: [MikroORM],
    },
  ],
  exports: [WalletRepository, WageringUnitOfWork],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
