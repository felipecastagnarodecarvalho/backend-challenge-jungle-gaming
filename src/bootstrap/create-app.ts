import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import type { InfrastructureOverrides } from '../infrastructure/infrastructure.module';
import { createRootLogger } from '../infrastructure/observability/logger';
import type { PrometheusMetrics } from '../infrastructure/observability/prometheus-metrics';
import { correlationIdMiddleware } from '../interface/http/correlation-id.middleware';
import { httpMetricsMiddleware } from '../interface/http/http-metrics.middleware';
import { AppModule } from './app.module';
import type { AppConfig } from './config';
import { METRICS } from './tokens';

/**
 * Builds the Nest application without listening — shared by `main.ts` and
 * in-process tests. `app.close()` runs the same shutdown hooks as SIGTERM.
 */
export async function createApp(config: AppConfig, overrides: InfrastructureOverrides = {}): Promise<INestApplication> {
  const rootLogger = createRootLogger({ level: config.logLevel, instanceId: config.instanceId });
  const app = await NestFactory.create(AppModule.register(config, rootLogger, overrides), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(correlationIdMiddleware);
  app.use(httpMetricsMiddleware(app.get<PrometheusMetrics>(METRICS).httpDuration));
  return app;
}
