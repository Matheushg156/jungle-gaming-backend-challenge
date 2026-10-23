import { RequestLoggingInterceptor } from './http/request-logging.interceptor';
import { MonitoringModule } from './infrastructure/observability/monitoring.module';
import { ConsumerModule } from './infrastructure/messaging/consumer.module';
import { Module } from '@nestjs/common';
import { WalletsModule } from './http/wallets/wallets.module';
import { WageringModule } from './http/wagering/wagering.module';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiExceptionFilter } from './http/api-exception.filter';
import { OutboxModule } from './infrastructure/messaging/outbox.module';

@Module({
  imports: [
    WalletsModule,
    WageringModule,
    OutboxModule,
    ConsumerModule,
    MonitoringModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
  ],
})
export class AppModule {}
