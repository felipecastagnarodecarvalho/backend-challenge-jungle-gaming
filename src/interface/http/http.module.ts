import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AppExceptionFilter } from './app-exception.filter';
import { ProviderAuthGuard } from './auth/provider-auth.guard';
import { HealthController } from './controllers/health.controller';
import { MetricsController } from './controllers/metrics.controller';
import { ProviderTransactionsController } from './controllers/provider-transactions.controller';
import { WageringController } from './controllers/wagering.controller';
import { WalletsController } from './controllers/wallets.controller';

@Module({
  controllers: [
    WalletsController,
    WageringController,
    ProviderTransactionsController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ProviderAuthGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class HttpModule {}
