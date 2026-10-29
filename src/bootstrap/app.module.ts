import type { IncomingMessage } from 'node:http';
import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Logger as Pino } from 'pino';
import { InfrastructureModule, type InfrastructureOverrides } from '../infrastructure/infrastructure.module';
import { HttpModule } from '../interface/http/http.module';
import { SqsConsumerModule } from '../interface/sqs/sqs-consumer.module';
import { WorkersModule } from '../interface/workers/workers.module';
import type { AppConfig } from './config';

@Module({})
export class AppModule {
  static register(config: AppConfig, rootLogger: Pino, overrides: InfrastructureOverrides = {}): DynamicModule {
    const imports: ModuleMetadata['imports'] = [
      LoggerModule.forRoot({
        pinoHttp: {
          logger: rootLogger,
          genReqId: (req: IncomingMessage) => String(req.headers['x-correlation-id'] ?? ''),
          customProps: (req: IncomingMessage) => ({ correlationId: String(req.headers['x-correlation-id'] ?? '') }),
          serializers: {
            req: (req: { method?: string; url?: string }) => ({ method: req.method, url: req.url }),
            res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
          },
          autoLogging: {
            ignore: (req: IncomingMessage) => Boolean(req.url?.startsWith('/health') || req.url === '/metrics'),
          },
        },
      }),
      InfrastructureModule.register(config, rootLogger, overrides),
      HttpModule,
      SqsConsumerModule,
      WorkersModule,
    ];
    return { module: AppModule, imports };
  }
}
