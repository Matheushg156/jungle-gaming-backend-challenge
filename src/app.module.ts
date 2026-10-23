import { Module } from '@nestjs/common';
import { WalletsModule } from './http/wallets/wallets.module';

@Module({ imports: [WalletsModule] })
export class AppModule {}
