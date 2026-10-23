import { ConsumerModule } from './infrastructure/messaging/consumer.module';
import { Module } from '@nestjs/common';
import { WalletsModule } from './http/wallets/wallets.module';
import { WageringModule } from './http/wagering/wagering.module';
import { APP_FILTER } from '@nestjs/core';
import { ApiExceptionFilter } from './http/api-exception.filter';
import { OutboxModule } from './infrastructure/messaging/outbox.module';

@Module({
  imports: [WalletsModule, WageringModule, OutboxModule, ConsumerModule],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
