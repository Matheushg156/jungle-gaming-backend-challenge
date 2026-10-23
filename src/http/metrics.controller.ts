import { UseGuards } from '@nestjs/common';
import { ProviderIdentityGuard, OperatorOnly } from './provider-identity.guard';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  Controller,
  Get,
  Header,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Registry } from '@prometheus-io/client';
import { ApplicationMetrics } from '../infrastructure/observability/application-metrics';

@OperatorOnly()
@UseGuards(ProviderIdentityGuard)
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(ApplicationMetrics) private readonly metrics: ApplicationMetrics,
    @Inject(MikroORM) private readonly orm: MikroORM,
  ) {}

  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  async getMetrics(): Promise<string> {
    try {
      const rows = await this.orm.em.fork().transactional(async (em) => {
        await em.execute("set local statement_timeout = '2s'");
        return em.execute<{ pending: string; lag: string }[]>(
          `select count(*)::text as pending,
           coalesce(greatest(0, extract(epoch from now() - min(occurred_at))), 0)::text as lag
           from outbox_messages where published_at is null`,
        );
      });
      this.metrics.updateOutbox(
        Number(rows[0]?.pending ?? '0'),
        Number(rows[0]?.lag ?? '0'),
      );
      return await this.metrics.render();
    } catch {
      throw new ServiceUnavailableException('Metrics dependencies unavailable');
    }
  }
}
