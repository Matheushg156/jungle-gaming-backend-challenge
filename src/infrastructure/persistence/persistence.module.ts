import { Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../application/ports/wallet.repository';
import { connectDatabase } from './database';
import { PostgresWalletRepository } from './repositories/postgres-wallet.repository';

@Module({
  providers: [
    { provide: MikroORM, useFactory: connectDatabase },
    {
      provide: WalletRepository,
      useFactory: (orm: MikroORM) => new PostgresWalletRepository(orm),
      inject: [MikroORM],
    },
  ],
  exports: [WalletRepository],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
