import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { METRICS } from '../../../bootstrap/tokens';
import type { PrometheusMetrics } from '../../../infrastructure/observability/prometheus-metrics';
import { Public } from '../auth/public.decorator';

/** Prometheus scrape endpoint (public; in production it would sit behind the internal network). */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PrometheusMetrics) {}

  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
