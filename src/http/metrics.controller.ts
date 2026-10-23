import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Registry } from '@prometheus-io/client';
import { ApplicationMetrics } from '../infrastructure/observability/application-metrics';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(ApplicationMetrics) private readonly metrics: ApplicationMetrics,
  ) {}

  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  getMetrics(): Promise<string> {
    return this.metrics.render();
  }
}
