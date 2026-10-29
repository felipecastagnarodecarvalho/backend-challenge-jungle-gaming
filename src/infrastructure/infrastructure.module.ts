import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import type { Logger as Pino } from 'pino';
import { PublishOutboxBatchUseCase } from '../application/outbox/publish-outbox-batch.use-case';
import type { MetricsPort } from '../application/ports/metrics';
import type {
  LedgerReadModel,
  ReconciliationReadModel,
  WagerTransactionReadModel,
  WalletReadModel,
} from '../application/ports/read-models';
import type {
  Clock,
  FaultInjector,
  IdGenerator,
  LoggerPort,
  MessagePublisher,
  ProviderIdentityPort,
} from '../application/ports/system';
import type { UnitOfWork } from '../application/ports/unit-of-work';
import { KeyedSerializer } from '../application/shared/keyed-serializer';
import type { RetryPolicy } from '../application/shared/transient-retry';
import { GetWagerTransactionQuery } from '../application/wager/get-wager-transaction.query';
import { ProcessWagerTransactionUseCase } from '../application/wager/process-wager-transaction.use-case';
import { ResolvePendingReferencesUseCase } from '../application/wager/resolve-pending-references.use-case';
import { WagerEvaluator } from '../application/wager/wager-evaluator';
import { CreateWalletUseCase } from '../application/wallet/create-wallet.use-case';
import { GetWalletQuery } from '../application/wallet/get-wallet.query';
import { GetWalletLedgerQuery } from '../application/wallet/get-wallet-ledger.query';
import { ReconcileWalletUseCase } from '../application/wallet/reconcile-wallet.use-case';
import type { AppConfig } from '../bootstrap/config';
import { ReadinessState } from '../bootstrap/readiness-state';
import * as T from '../bootstrap/tokens';
import { ReferenceRetryPolicy } from '../domain/wager/reference-retry-policy';
import { HealthChecker } from './health/health-checker';
import { DisabledProviderIdentity } from './identity/disabled-provider-identity';
import { JwksProviderIdentity } from './identity/jwks-provider-identity';
import { QueueRegistry } from './messaging/queue-registry';
import { createSqsClient } from './messaging/sqs-client';
import { SqsMessagePublisher } from './messaging/sqs-message-publisher';
import { PinoLoggerAdapter } from './observability/logger';
import { PrometheusMetrics } from './observability/prometheus-metrics';
import { createQueueDepthSource } from './observability/queue-depth';
import { MikroUnitOfWork } from './persistence/mikro-unit-of-work';
import { createOrm } from './persistence/orm';
import { MikroReadModels, MikroWagerTransactionReadModel } from './persistence/repositories/mikro-read-models';
import { EnvFaultInjector } from './system/env-fault-injector';
import { SystemClock } from './system/system-clock';
import { UuidV7IdGenerator } from './system/uuidv7-id-generator';

/** Optional replacements used by in-process tests (never by production code). */
export interface InfrastructureOverrides {
  identity?: ProviderIdentityPort;
  publisher?: MessagePublisher;
}

/** Wires scrape-time gauges after construction and releases connections on shutdown. */
@Injectable()
class InfrastructureLifecycle implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(
    @Inject(T.MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(T.SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(T.METRICS) private readonly metrics: PrometheusMetrics,
    @Inject(T.READ_MODELS) private readonly readModels: MikroReadModels,
    @Inject(T.QUEUE_REGISTRY) private readonly queues: QueueRegistry,
    @Inject(T.APP_CONFIG) private readonly config: AppConfig,
    @Inject(T.LOGGER) private readonly logger: LoggerPort,
    @Inject(T.READINESS_STATE) private readonly readiness: ReadinessState,
  ) {}

  /** First step of graceful shutdown: report not-ready so traffic drains. */
  beforeApplicationShutdown(): void {
    this.readiness.shuttingDown = true;
  }

  onModuleInit(): void {
    this.metrics.registerGauges(
      {
        outboxPending: () => this.readModels.outboxPending(),
        pendingReferences: () => this.readModels.pendingReferences(),
        queueDepths: createQueueDepthSource(this.sqs, this.queues, {
          main: this.config.sqs.wagerQueueName,
          dlq: this.config.sqs.wagerDlqName,
        }),
      },
      (what, err) =>
        this.logger.warn(
          { gauge: what, err: err instanceof Error ? err.message : String(err) },
          'gauge collection failed',
        ),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
    this.sqs.destroy();
  }
}

/**
 * Composition of all adapters and use cases. Use cases are plain classes
 * (no Nest decorators) built in factories, keeping the application layer
 * framework-free.
 */
@Global()
@Module({})
export class InfrastructureModule {
  static register(config: AppConfig, rootLogger: Pino, overrides: InfrastructureOverrides = {}): DynamicModule {
    const retry: RetryPolicy = { maxAttempts: config.db.txMaxAttempts };
    // One per-wallet in-process queue per instance, shared by HTTP/SQS submissions and the pending-reference worker.
    const walletGate = new KeyedSerializer();
    const providers: Provider[] = [
      { provide: T.APP_CONFIG, useValue: config },
      { provide: T.ROOT_PINO, useValue: rootLogger },
      { provide: T.LOGGER, useValue: new PinoLoggerAdapter(rootLogger) },
      { provide: T.RETRY_POLICY, useValue: retry },
      { provide: T.READINESS_STATE, useValue: new ReadinessState() },
      { provide: T.CLOCK, useValue: new SystemClock() },
      { provide: T.ID_GENERATOR, useValue: new UuidV7IdGenerator() },
      { provide: T.FAULT_INJECTOR, useValue: new EnvFaultInjector(config.faults) },
      { provide: T.METRICS, useValue: new PrometheusMetrics({ instance: config.instanceId }) },
      {
        provide: T.PROVIDER_IDENTITY,
        useValue:
          overrides.identity ??
          (config.auth.enabled
            ? JwksProviderIdentity.remote({
                issuer: config.auth.issuer as string,
                jwksUrl: config.auth.jwksUrl as string,
                audience: config.auth.audience,
                providerClaim: config.auth.providerClaim,
              })
            : new DisabledProviderIdentity()),
      },
      {
        provide: T.MIKRO_ORM,
        useFactory: () => createOrm({ url: config.db.url, poolMax: config.db.poolMax }),
      },
      {
        provide: T.UNIT_OF_WORK,
        useFactory: (orm: MikroORM) =>
          new MikroUnitOfWork(orm, {
            lockTimeoutMs: config.db.lockTimeoutMs,
            statementTimeoutMs: config.db.statementTimeoutMs,
          }),
        inject: [T.MIKRO_ORM],
      },
      { provide: T.READ_MODELS, useFactory: (orm: MikroORM) => new MikroReadModels(orm), inject: [T.MIKRO_ORM] },
      { provide: T.WALLET_READ_MODEL, useExisting: T.READ_MODELS },
      { provide: T.LEDGER_READ_MODEL, useExisting: T.READ_MODELS },
      { provide: T.RECONCILIATION_READ_MODEL, useExisting: T.READ_MODELS },
      { provide: T.GAUGES_READ_MODEL, useExisting: T.READ_MODELS },
      {
        provide: T.WAGER_TX_READ_MODEL,
        useFactory: (m: MikroReadModels) => new MikroWagerTransactionReadModel(m),
        inject: [T.READ_MODELS],
      },
      { provide: T.SQS_CLIENT, useFactory: () => createSqsClient(config.aws) },
      { provide: T.QUEUE_REGISTRY, useFactory: (c: SQSClient) => new QueueRegistry(c), inject: [T.SQS_CLIENT] },
      {
        provide: T.MESSAGE_PUBLISHER,
        useFactory: (c: SQSClient, q: QueueRegistry) =>
          overrides.publisher ?? new SqsMessagePublisher(c, q, config.sqs.eventsQueueName),
        inject: [T.SQS_CLIENT, T.QUEUE_REGISTRY],
      },
      {
        provide: T.HEALTH_CHECKER,
        useFactory: (orm: MikroORM, c: SQSClient, q: QueueRegistry) =>
          new HealthChecker(orm, c, q, config.sqs.wagerQueueName),
        inject: [T.MIKRO_ORM, T.SQS_CLIENT, T.QUEUE_REGISTRY],
      },
      {
        provide: WagerEvaluator,
        useFactory: (ids: IdGenerator) =>
          new WagerEvaluator(
            ids,
            new ReferenceRetryPolicy({
              baseDelayMs: config.pendingRef.baseDelayMs,
              maxDelayMs: config.pendingRef.maxDelayMs,
              maxAttempts: config.pendingRef.maxAttempts,
            }),
          ),
        inject: [T.ID_GENERATOR],
      },
      {
        provide: ProcessWagerTransactionUseCase,
        useFactory: (
          uow: UnitOfWork,
          evaluator: WagerEvaluator,
          clock: Clock,
          ids: IdGenerator,
          metrics: MetricsPort,
          logger: LoggerPort,
          faults: FaultInjector,
        ) =>
          new ProcessWagerTransactionUseCase({
            uow,
            evaluator,
            clock,
            ids,
            metrics,
            logger,
            faults,
            retry,
            walletGate,
          }),
        inject: [T.UNIT_OF_WORK, WagerEvaluator, T.CLOCK, T.ID_GENERATOR, T.METRICS, T.LOGGER, T.FAULT_INJECTOR],
      },
      {
        provide: ResolvePendingReferencesUseCase,
        useFactory: (
          uow: UnitOfWork,
          evaluator: WagerEvaluator,
          clock: Clock,
          ids: IdGenerator,
          metrics: MetricsPort,
          logger: LoggerPort,
        ) =>
          new ResolvePendingReferencesUseCase({
            uow,
            evaluator,
            clock,
            ids,
            metrics,
            logger: logger.child({ component: 'pending-reference-worker' }),
            retry,
            batchSize: config.pendingRef.batchSize,
            leaseMs: config.pendingRef.leaseMs,
            walletGate,
          }),
        inject: [T.UNIT_OF_WORK, WagerEvaluator, T.CLOCK, T.ID_GENERATOR, T.METRICS, T.LOGGER],
      },
      {
        provide: PublishOutboxBatchUseCase,
        useFactory: (
          uow: UnitOfWork,
          publisher: MessagePublisher,
          clock: Clock,
          metrics: MetricsPort,
          logger: LoggerPort,
          faults: FaultInjector,
        ) =>
          new PublishOutboxBatchUseCase({
            uow,
            publisher,
            clock,
            metrics,
            logger: logger.child({ component: 'outbox-publisher' }),
            faults,
            batchSize: config.outbox.batchSize,
            leaseMs: config.outbox.leaseMs,
            backoff: { baseMs: config.outbox.retryBaseMs, maxMs: config.outbox.retryMaxMs },
          }),
        inject: [T.UNIT_OF_WORK, T.MESSAGE_PUBLISHER, T.CLOCK, T.METRICS, T.LOGGER, T.FAULT_INJECTOR],
      },
      {
        provide: CreateWalletUseCase,
        useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: MetricsPort, logger: LoggerPort) =>
          new CreateWalletUseCase({ uow, clock, ids, metrics, logger, retry }),
        inject: [T.UNIT_OF_WORK, T.CLOCK, T.ID_GENERATOR, T.METRICS, T.LOGGER],
      },
      {
        provide: GetWalletQuery,
        useFactory: (m: WalletReadModel) => new GetWalletQuery(m),
        inject: [T.WALLET_READ_MODEL],
      },
      {
        provide: GetWalletLedgerQuery,
        useFactory: (w: WalletReadModel, l: LedgerReadModel) => new GetWalletLedgerQuery(w, l),
        inject: [T.WALLET_READ_MODEL, T.LEDGER_READ_MODEL],
      },
      {
        provide: GetWagerTransactionQuery,
        useFactory: (m: WagerTransactionReadModel) => new GetWagerTransactionQuery(m),
        inject: [T.WAGER_TX_READ_MODEL],
      },
      {
        provide: ReconcileWalletUseCase,
        useFactory: (m: ReconciliationReadModel, metrics: MetricsPort, logger: LoggerPort) =>
          new ReconcileWalletUseCase(m, metrics, logger),
        inject: [T.RECONCILIATION_READ_MODEL, T.METRICS, T.LOGGER],
      },
      InfrastructureLifecycle,
    ];
    const exported = providers
      .filter((p) => p !== InfrastructureLifecycle)
      .map((p) => (p as { provide: unknown }).provide);
    return {
      module: InfrastructureModule,
      providers,
      exports: exported as DynamicModule['exports'],
    };
  }
}
