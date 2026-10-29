# DESIGN — Distributed Wagering Processor

> Documento de design **implementation-ready**. O agente executor deve segui-lo literalmente.
> Idioma: português; identificadores de código em inglês.
> Enunciado original: `README.md` na raiz (será movido para `docs/CHALLENGE.md` na Fase 0).
> Seções referenciadas como "§N do desafio" apontam para o enunciado.

---

## 0. Sumário das decisões-chave

| Tema | Decisão | Justificativa curta |
|---|---|---|
| Runtime | Bun 1.4.4 executando TypeScript diretamente (sem build) | Exigido; `tsc --noEmit` só para type-check |
| Framework | NestJS 12.3.2 (ESM) | Testado sob Bun 1.4.4 (DI, decorators, shutdown hooks OK) |
| ORM | MikroORM 7.2.5 + `EntitySchema` (sem decorators), migrations SQL manuais | Domínio limpo; constraints/triggers escritas à mão e revisáveis |
| Dinheiro | `decimal.js` 10.6.0 no domínio; `NUMERIC(20,2)` + `CHAR(3)` no banco; string decimal nos contratos | Exatidão; driver devolve `numeric` como string (verificado) |
| Concorrência | Lock pessimista por wallet (`SELECT … FOR UPDATE`) em `READ COMMITTED`, `lock_timeout` curto, retry limitado para erros transitórios, `version` incrementada; constraints e triggers como última linha de defesa | Hot wallet sem tempestade de retries; sem lock global |
| Idempotência | Linha em `wager_transactions` com `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)`; re-checagem após adquirir o lock; `INSERT … ON CONFLICT DO NOTHING` para corrida residual | Persistente, à prova de múltiplas instâncias |
| Payload hash | SHA-256 hex do JSON canônico (chaves ordenadas) de 9 campos de negócio | Documentado com vetor de teste (§8.2) |
| Integridade no schema | CHECKs, UNIQUEs, FKs compostas (moeda/wallet), índice parcial de reversão única, trigger append-only no ledger, trigger de encadeamento do ledger, trigger de versão da wallet, **constraint trigger diferido** que exige ledger para todo saldo, guarda de transições terminais | §5.9 do desafio; SQL validado em Postgres 16 |
| Mensageria | SQS FIFO (LocalStack 3.8), inbox `(consumer_name, message_id)`, ack após commit, backoff via `ChangeMessageVisibility`, DLQ por redrive (`maxReceiveCount=5`) + envio explícito para poison | §10 |
| Outbox | Claim com `FOR UPDATE SKIP LOCKED` + **lease** (`next_attempt_at = now()+lease`), publicação fora da transação, `markPublished`, backoff exponencial sem descarte | Vários publishers, crash-safe, at-least-once com `eventId` |
| PENDING_REFERENCE | Worker agendado com claim+lease, backoff exponencial 2s→300s, **10 tentativas (~18,5 min)** → `REJECTED/REFERENCE_NOT_FOUND` + evento | §7.1 |
| Validação | `zod` 4.6.7 (schemas compartilhados HTTP/SQS) | Sem decorators, mesma validação nas duas entradas |
| Logs/Métricas | `pino` + `nestjs-pino` (JSON, redaction), `prom-client` em `GET /metrics` | §12 |
| Auth | Implementada como extra **opcional**: `ProviderIdentityPort` + guard JWT (`jose`, JWKS do Keycloak 26.4 em profile `auth`), **desligada por padrão** (`AUTH_ENABLED=false`) | §2: não pontua; custo baixo, ponto de extensão explícito |
| Testes | `bun test`; unit sem infra; integração e concorrência contra Postgres/LocalStack reais; ≥3 processos via `Bun.spawn`; fault injection por env | §13 |
| Compose | postgres:16-alpine, localstack/localstack:3.8, one-shots `migrate` e `sqs-init`, `app-1..3`, keycloak (profile `auth`) | Imagens verificadas |

---

## 1. Arquitetura

### 1.1 Visão geral

```mermaid
graph TD
  Provider["Provedores de jogos"] -->|HTTP| HTTP["interface/http (Nest controllers)"]
  Provider -->|SQS FIFO wager-transactions.fifo| SQSC["interface/sqs (consumer long-polling)"]
  HTTP --> UC["application: ProcessWagerTransaction / CreateWallet / Queries / Reconcile"]
  SQSC --> UC
  UC --> DOM["domain: Money, Wallet, WagerTransaction, WalletLedgerEntry, WagerPolicy"]
  UC --> PORTS["application/ports (UnitOfWork, Repos, Clock, IdGenerator, Metrics...)"]
  PORTS -.implementa.-> INFRA["infrastructure: MikroORM repos, SQS publisher, prom-client, pino"]
  INFRA --> PG[("PostgreSQL 16\nwallets / wager_transactions / ledger / inbox / outbox")]
  W1["interface/workers: OutboxPublisher"] --> PG
  W1 -->|SendMessageBatch| EVQ["SQS wallet-events.fifo"]
  W2["interface/workers: PendingReferenceWorker"] --> UC
  SQSC -->|poison / redrive| DLQ["wager-transactions-dlq.fifo"]
```

Cada instância da aplicação roda **os mesmos componentes** (HTTP + consumer + outbox publisher + pending-reference worker), cada um ligável/desligável por env. A correção nunca depende de haver uma única instância.

### 1.2 Camadas e regra de dependência

| Camada | Pode importar | NÃO pode importar |
|---|---|---|
| `src/domain` | apenas `decimal.js` e outros arquivos de `domain` | `@nestjs/*`, `@mikro-orm/*`, `@aws-sdk/*`, `pino`, `prom-client`, `zod`, `jose`, `node:*`, `bun` |
| `src/application` | `domain`, `node:crypto` (hash) | `@nestjs/*`, `@mikro-orm/*`, `@aws-sdk/*`, `pino`, `prom-client`, `zod`, `jose` |
| `src/infrastructure` | tudo acima + libs de infra | `src/interface` |
| `src/interface` | `application`, `domain` (tipos/enum), `zod`, `@nestjs/*` | repositórios concretos (só via tokens/ports) |
| `src/bootstrap` | tudo (composition root) | — |

Essa regra é **verificada por teste** (`tests/unit/architecture.test.ts`, ver §18).

Use cases e serviços de aplicação são classes TypeScript puras (sem `@Injectable`); são instanciados em `useFactory` nos módulos Nest. Todo construtor de provider Nest usa `@Inject(TOKEN)` explícito em **todos** os parâmetros (não depender de `emitDecoratorMetadata` para interfaces — elas viram `Object` no metadata).

---

## 2. Layout de diretórios e arquivos

Todos os arquivos abaixo devem ser criados (nenhum outro é necessário, exceto testes adicionais).

### 2.1 Raiz

| Arquivo | Propósito |
|---|---|
| `package.json` | dependências fixas (sem `^`), `"type": "module"`, scripts (§3.3) |
| `bun.lock` | lockfile gerado pelo `bun install` (commitado) |
| `tsconfig.json` | TS estrito + decorators (§3.2) |
| `biome.json` | lint/format (Biome 2.6.4), regras recomendadas, `noExplicitAny: error` |
| `bunfig.toml` | `[test] timeout = 20000` |
| `.gitattributes` | `* text=auto eol=lf` (evita CRLF em scripts/SQL no Windows) |
| `.gitignore` | `node_modules`, `.env`, `coverage`, `*.log` |
| `.dockerignore` | `node_modules`, `.git`, `tests`, `docs`, `.agents`, `.aider-desk` |
| `.env.example` | todas as variáveis de §16 com defaults de desenvolvimento |
| `Dockerfile` | imagem `oven/bun:1.4.4` (§17.2) |
| `docker-compose.yml` | postgres, localstack, migrate, sqs-init, app-1..3, keycloak (profile `auth`) (§17.1) |
| `README.md` | **novo** README com setup e comandos (Fase 11) |
| `docs/CHALLENGE.md` | enunciado original (movido do README) |
| `docs/DESIGN.md` | este documento |
| `docs/ARCHITECTURE.md` | decisões, trade-offs e limitações (Fase 11; base: §21 e §22 deste doc) |
| `docs/LOAD_TEST.md` | relatório gerado/curado do teste de carga (Fase 10) |
| `docs/NOTES.md` | diário de trabalho (já existe) |

### 2.2 `docker/`

| Arquivo | Propósito |
|---|---|
| `docker/postgres/init/01-create-test-db.sql` | `CREATE DATABASE wagering_test OWNER wagering;` (executado na 1ª subida do volume) |
| `docker/keycloak/wagering-realm.json` | realm `wagering` com clients `provider-a`/`provider-b` (client credentials) e claim `provider_id` (§15) |

### 2.3 `src/`

```
src/
  main.ts
  bootstrap/
    app.module.ts
    create-app.ts
    config.ts
    tokens.ts
    readiness-state.ts
  domain/
    shared/domain-error.ts
    money/money.ts
    wallet/wallet.ts
    wallet/wallet.errors.ts
    ledger/ledger-direction.ts
    ledger/wallet-ledger-entry.ts
    wager/wager-transaction-kind.ts
    wager/wager-transaction-status.ts
    wager/failure-code.ts
    wager/wager-transaction.ts
    wager/wager-policy.ts
    wager/reference-retry-policy.ts
    wager/wager.errors.ts
  application/
    errors.ts
    ports/unit-of-work.ts
    ports/wallet-repository.ts
    ports/wager-transaction-repository.ts
    ports/ledger-repository.ts
    ports/inbox-repository.ts
    ports/outbox-repository.ts
    ports/read-models.ts
    ports/message-publisher.ts
    ports/clock.ts
    ports/id-generator.ts
    ports/metrics.ts
    ports/logger.ts
    ports/provider-identity.ts
    ports/fault-injector.ts
    messaging/integration-event.ts
    messaging/events.ts
    messaging/outbox-message.ts
    messaging/inbox-message.ts
    messaging/backoff.ts
    shared/transient-retry.ts
    shared/canonical-json.ts
    wager/process-wager-command.ts
    wager/payload-hash.ts
    wager/wager-result.ts
    wager/wager-evaluator.ts
    wager/process-wager-transaction.use-case.ts
    wager/resolve-pending-references.use-case.ts
    wager/get-wager-transaction.query.ts
    wallet/create-wallet.use-case.ts
    wallet/get-wallet.query.ts
    wallet/ledger-cursor.ts
    wallet/get-wallet-ledger.query.ts
    wallet/reconcile-wallet.use-case.ts
    outbox/publish-outbox-batch.use-case.ts
  infrastructure/
    infrastructure.module.ts
    persistence/orm.ts
    persistence/pg-error-classifier.ts
    persistence/mikro-unit-of-work.ts
    persistence/schemas/wallet.schema.ts
    persistence/schemas/wager-transaction.schema.ts
    persistence/schemas/ledger-entry.schema.ts
    persistence/schemas/inbox-message.schema.ts
    persistence/schemas/outbox-message.schema.ts
    persistence/mappers/wallet.mapper.ts
    persistence/mappers/wager-transaction.mapper.ts
    persistence/mappers/ledger-entry.mapper.ts
    persistence/mappers/inbox-message.mapper.ts
    persistence/mappers/outbox-message.mapper.ts
    persistence/repositories/mikro-wallet.repository.ts
    persistence/repositories/mikro-wager-transaction.repository.ts
    persistence/repositories/mikro-ledger.repository.ts
    persistence/repositories/mikro-inbox.repository.ts
    persistence/repositories/mikro-outbox.repository.ts
    persistence/repositories/mikro-read-models.ts
    persistence/migrations/Migration20261029000001CoreTables.ts
    persistence/migrations/Migration20261029000002IntegrityTriggers.ts
    persistence/migrations/Migration20261029000003Messaging.ts
    persistence/migrations/index.ts
    persistence/migrate-cli.ts
    messaging/sqs-client.ts
    messaging/queue-registry.ts
    messaging/queue-provisioner.ts
    messaging/sqs-message-publisher.ts
    observability/logger.ts
    observability/prometheus-metrics.ts
    observability/db-gauges.collector.ts
    health/health-checker.ts
    identity/disabled-provider-identity.ts
    identity/jwks-provider-identity.ts
    system/system-clock.ts
    system/uuidv7-id-generator.ts
    system/env-fault-injector.ts
  interface/
    shared/money.schema.ts
    shared/wager-request.schema.ts
    http/http.module.ts
    http/http-error.ts
    http/correlation-id.middleware.ts
    http/zod-validation.pipe.ts
    http/app-exception.filter.ts
    http/presenters.ts
    http/auth/public.decorator.ts
    http/auth/provider-auth.guard.ts
    http/auth/current-provider.decorator.ts
    http/controllers/wallets.controller.ts
    http/controllers/wagering.controller.ts
    http/controllers/provider-transactions.controller.ts
    http/controllers/health.controller.ts
    http/controllers/metrics.controller.ts
    sqs/sqs-consumer.module.ts
    sqs/sqs-envelope.schema.ts
    sqs/message-classifier.ts
    sqs/wager-transactions.consumer.ts
    workers/workers.module.ts
    workers/polling-worker.ts
    workers/outbox-publisher.worker.ts
    workers/pending-reference.worker.ts
```

Propósito de cada arquivo:

| Arquivo | Propósito |
|---|---|
| `main.ts` | `import 'reflect-metadata'`; `loadConfig()`; `createApp(config)`; `enableShutdownHooks(['SIGTERM','SIGINT'])`; `listen(PORT)` |
| `bootstrap/app.module.ts` | `AppModule.register(config)` → DynamicModule importando LoggerModule, InfrastructureModule, HttpModule, SqsConsumerModule, WorkersModule |
| `bootstrap/create-app.ts` | `createApp(config): Promise<INestApplication>` (sem `listen`) — usado por `main.ts` e por testes in-process |
| `bootstrap/config.ts` | schema zod do ambiente → `AppConfig` tipado e imutável; `loadConfig(env = process.env, overrides?)` |
| `bootstrap/tokens.ts` | `Symbol`s de DI (lista em §6.6) |
| `bootstrap/readiness-state.ts` | flag `shuttingDown` consultada pelo `/health/ready` |
| `domain/shared/domain-error.ts` | `abstract class DomainError extends Error { abstract readonly code: string }` |
| `domain/money/money.ts` | value object `Money` (§4.1) |
| `domain/wallet/wallet.ts` | aggregate root `Wallet` (§4.2) |
| `domain/wallet/wallet.errors.ts` | `InsufficientFundsError`, `CurrencyMismatchError`, `InvalidWalletError` |
| `domain/ledger/ledger-direction.ts` | `LedgerDirection` (`DEBIT`/`CREDIT`) como `as const` + tipo |
| `domain/ledger/wallet-ledger-entry.ts` | `WalletLedgerEntry` imutável (§4.4) |
| `domain/wager/wager-transaction-kind.ts` | `WagerTransactionKind` `as const` + `SUBMITTABLE_KINDS` |
| `domain/wager/wager-transaction-status.ts` | `WagerTransactionStatus` `as const` + `TERMINAL_STATUSES` |
| `domain/wager/failure-code.ts` | `FailureCode` `as const` + metadados `retryable`/descrição (§5.2) |
| `domain/wager/wager-transaction.ts` | entidade `WagerTransaction` com máquina de estados (§4.3, §5.1) |
| `domain/wager/wager-policy.ts` | serviço de domínio puro `WagerPolicy.decide()` (§4.5) |
| `domain/wager/reference-retry-policy.ts` | cálculo de backoff/expiração de PENDING_REFERENCE (puro) |
| `domain/wager/wager.errors.ts` | `InvalidWagerTransactionError`, `InvalidTransactionStateError` |
| `application/errors.ts` | erros de aplicação (§6.5) |
| `application/ports/*.ts` | interfaces de portas (§6.1–6.4) |
| `application/messaging/integration-event.ts` | classe abstrata `IntegrationEvent<T>` + `EventContext` |
| `application/messaging/events.ts` | 5 subclasses concretas (§13.4) |
| `application/messaging/outbox-message.ts` | `OutboxMessage` (enqueue/rehydrate/markPublished/scheduleRetry) |
| `application/messaging/inbox-message.ts` | `InboxMessage` (receive/rehydrate/markProcessed) |
| `application/messaging/backoff.ts` | `exponentialBackoffMs(attempt, baseMs, maxMs)` puro |
| `application/shared/transient-retry.ts` | `withTransientRetry(fn, policy, metrics, op)` (§7.4) |
| `application/shared/canonical-json.ts` | `canonicalJson(value)` (§8.2) |
| `application/wager/process-wager-command.ts` | tipos `ProcessWagerCommand`, `CommandSource` |
| `application/wager/payload-hash.ts` | `computeWagerPayloadHash(cmd)` (§8.2) |
| `application/wager/wager-result.ts` | união discriminada `ProcessWagerResult` + `toResultFromTransaction()` |
| `application/wager/wager-evaluator.ts` | aplica a decisão da policy (ledger, wallet, eventos) — compartilhado entre submissão e worker |
| `application/wager/process-wager-transaction.use-case.ts` | use case único usado por HTTP e SQS (§8) |
| `application/wager/resolve-pending-references.use-case.ts` | processamento de um lote de PENDING_REFERENCE (§10) |
| `application/wager/get-wager-transaction.query.ts` | consultas por id e por (provider, externalId) |
| `application/wallet/create-wallet.use-case.ts` | criação de wallet + OPENING (§9.1) |
| `application/wallet/get-wallet.query.ts` | consulta de wallet |
| `application/wallet/ledger-cursor.ts` | encode/decode do cursor opaco (§11.4) |
| `application/wallet/get-wallet-ledger.query.ts` | paginação do ledger |
| `application/wallet/reconcile-wallet.use-case.ts` | reconciliação (§9.3) |
| `application/outbox/publish-outbox-batch.use-case.ts` | claim → publish → mark/retry (§13) |
| `infrastructure/infrastructure.module.ts` | `@Global()`; provê ORM, UoW, read models, SQS, métricas, logger, clock, ids, identity, fault injector, health checker e todos os use cases via `useFactory` |
| `infrastructure/persistence/orm.ts` | `createOrm(config)` → `MikroORM.init` (§6.7) |
| `infrastructure/persistence/pg-error-classifier.ts` | SQLSTATE → erros de aplicação (§7.3) |
| `infrastructure/persistence/mikro-unit-of-work.ts` | implementação de `UnitOfWork` (§6.7) |
| `infrastructure/persistence/schemas/*.schema.ts` | `EntitySchema` de registros de persistência (records planos, sem lógica) |
| `infrastructure/persistence/mappers/*.mapper.ts` | `toDomain(record)` via `rehydrate` e `toRecord(entity)` |
| `infrastructure/persistence/repositories/mikro-*.repository.ts` | adapters das portas, ligados a um `EntityManager` transacional |
| `infrastructure/persistence/repositories/mikro-read-models.ts` | queries de leitura fora de transação (wallet, ledger page, tx, reconciliação, gauges) |
| `infrastructure/persistence/migrations/Migration2026102900000{1,2,3}*.ts` | migrations SQL com `up`/`down` (§7 SQL em §6.8) |
| `infrastructure/persistence/migrations/index.ts` | `migrationsList` explícito (ordem fixa) |
| `infrastructure/persistence/migrate-cli.ts` | CLI `up` / `down [--to name]` / `status` usando `orm.migrator` |
| `infrastructure/messaging/sqs-client.ts` | factory do `SQSClient` (endpoint, região, credenciais) |
| `infrastructure/messaging/queue-registry.ts` | resolve e cacheia URLs/ARNs das filas por nome (`GetQueueUrl`) |
| `infrastructure/messaging/queue-provisioner.ts` | `ensureQueues(names, opts)` idempotente (FIFO, DLQ, redrive) |
| `infrastructure/messaging/sqs-message-publisher.ts` | `MessagePublisher` via `SendMessageBatch` para `wallet-events.fifo` |
| `infrastructure/observability/logger.ts` | instância raiz pino (redaction, base fields) + adapter `LoggerPort` |
| `infrastructure/observability/prometheus-metrics.ts` | `Registry` + todas as métricas (§14.2) + adapter `MetricsPort` |
| `infrastructure/observability/db-gauges.collector.ts` | callbacks `collect()` para gauges que consultam o banco (outbox lag, pending refs) |
| `infrastructure/health/health-checker.ts` | checks DB (`SELECT 1`) e SQS (`GetQueueAttributes`) com timeout |
| `infrastructure/identity/disabled-provider-identity.ts` | `ProviderIdentityPort` no-op (auth desligada) |
| `infrastructure/identity/jwks-provider-identity.ts` | verificação JWT via `jose.createRemoteJWKSet` |
| `infrastructure/system/system-clock.ts` | `Clock` real |
| `infrastructure/system/uuidv7-id-generator.ts` | `IdGenerator` com `uuidv7()` |
| `infrastructure/system/env-fault-injector.ts` | fault injection controlada por env (§18.6) |
| `interface/shared/money.schema.ts` | zod de `MoneyProps` (string decimal estrita) |
| `interface/shared/wager-request.schema.ts` | zod do corpo de negócio comum a HTTP e SQS |
| `interface/http/http.module.ts` | controllers, guard global, filter global, middleware de correlation id |
| `interface/http/http-error.ts` | formato do corpo de erro e helpers |
| `interface/http/correlation-id.middleware.ts` | lê/gera `X-Correlation-Id` e o devolve na resposta |
| `interface/http/zod-validation.pipe.ts` | pipe genérico que converte `ZodError` em `ValidationError` |
| `interface/http/app-exception.filter.ts` | mapeia erros → status HTTP + corpo padronizado (§11.2) |
| `interface/http/presenters.ts` | converte resultados/read models em JSON de resposta |
| `interface/http/auth/*.ts` | `@Public()`, guard, `@CurrentProvider()` (§15) |
| `interface/http/controllers/*.ts` | endpoints (§11) |
| `interface/sqs/sqs-consumer.module.ts` | registra o consumer |
| `interface/sqs/sqs-envelope.schema.ts` | zod do envelope `WagerTransactionRequested` |
| `interface/sqs/message-classifier.ts` | resultado/erro → ação (`ACK`, `RETRY`, `DLQ`) (§12.3) |
| `interface/sqs/wager-transactions.consumer.ts` | loop de long-polling + shutdown gracioso (§12) |
| `interface/workers/workers.module.ts` | registra workers |
| `interface/workers/polling-worker.ts` | loop genérico start/stop com `AbortController` |
| `interface/workers/outbox-publisher.worker.ts` | executa `PublishOutboxBatch` em loop |
| `interface/workers/pending-reference.worker.ts` | executa `ResolvePendingReferences` em loop |

### 2.4 `scripts/`

| Arquivo | Propósito |
|---|---|
| `scripts/setup-queues.ts` | cria filas principais (usa `queue-provisioner`); usado pelo serviço `sqs-init` e localmente |
| `scripts/reset-test-db.ts` | `DROP DATABASE IF EXISTS wagering_test WITH (FORCE)` + `CREATE` + migrations up (via `Bun.SQL` no DB `postgres`) |
| `scripts/send-sample-message.ts` | envia mensagem de exemplo para a fila (demo manual) |
| `scripts/load-test.ts` | teste de carga (§19) |

### 2.5 `tests/`

```
tests/
  support/env.ts               # config de teste (DB wagering_test, prefixos de fila)
  support/db.ts                # Bun.SQL client + helpers de consulta
  support/invariants.ts        # assertWalletConsistent(walletId) etc.
  support/sqs.ts               # createTestQueues(prefix), receiveAll, queueDepth
  support/app-process.ts       # spawnApp / startCluster / stop / kill / waitReady
  support/in-process-app.ts    # createApp() com overrides, para testes de integração
  support/factories.ts         # builders de comando/request, createWalletViaApi
  support/wait-for.ts          # waitFor(predicate, {timeoutMs, intervalMs})
  support/fakes.ts             # fakes em memória de portas (somente para unit tests)
  unit/...                     # §18.2
  integration/...              # §18.3
  concurrency/...              # §18.4
```

---

## 3. Bibliotecas, versões e configuração

### 3.1 Dependências (versões exatas, verificadas sob Bun 1.4.4 em 2026-10-29)

Foi executado um smoke test real: Nest 12 (DI implícita e via `@Inject`, controllers, shutdown), MikroORM 7.2.5 (`EntitySchema`, `migrationsList`, `up`/`down`, `LockMode.PESSIMISTIC_WRITE`, `em.execute` com `?`, `ON CONFLICT DO NOTHING RETURNING`), SQS FIFO + redrive para DLQ no LocalStack 3.8, nestjs-pino (redaction), prom-client (default metrics), zod 4, jose 6. `tsc --noEmit` (5.9.3) limpo.

`dependencies`:

| Pacote | Versão |
|---|---|
| `@nestjs/common` | `12.3.2` |
| `@nestjs/core` | `12.3.2` |
| `@nestjs/platform-express` | `12.3.2` |
| `reflect-metadata` | `0.2.2` |
| `rxjs` | `7.8.2` |
| `@mikro-orm/core` | `7.2.5` |
| `@mikro-orm/postgresql` | `7.2.5` |
| `@mikro-orm/migrations` | `7.2.5` |
| `decimal.js` | `10.6.0` |
| `@aws-sdk/client-sqs` | `3.1160.0` |
| `nestjs-pino` | `5.3.1` |
| `pino` | `10.4.0` |
| `pino-http` | `11.0.0` |
| `prom-client` | `15.1.3` |
| `zod` | `4.6.7` |
| `jose` | `6.2.14` |
| `uuidv7` | `1.2.1` |

`devDependencies`: `typescript@5.9.3`, `@types/bun@1.4.4`, `@biomejs/biome@2.6.4`.

Notas:
- **Não** usar TypeScript 7.x (compilador nativo novo; não validado com `experimentalDecorators`). Fixar 5.9.3.
- **Não** usar `@mikro-orm/nestjs` (evita RequestContext implícito; usamos `em.fork()` explícito). **Não** usar `@nestjs/config` nem `@nestjs/terminus` (config via zod; health simples).
- **Não** usar `class-validator`/`class-transformer`.
- Testes usam o cliente Postgres nativo do Bun (`import { SQL } from 'bun'`) para asserções — sem dependência extra.
- Todos os pacotes Nest 12 / MikroORM 7 são ESM (`"type": "module"`). Imports internos sem extensão (resolução `bundler`).
- `numeric` volta do driver como **string** (`"20.00"`) — verificado. Nunca converter para `number`.
- Erro de `lock_timeout` (SQLSTATE `55P03`) chega como `DriverException` genérica (não `LockWaitTimeoutException`) — **classificar sempre por `err.code`** (SQLSTATE), nunca por `instanceof`. `DriverException` copia todas as props do erro do `pg` (`code`, `constraint`, `detail`).

### 3.2 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "Preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "useUnknownInCatchVariables": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun"],
    "isolatedModules": true,
    "esModuleInterop": true
  },
  "include": ["src", "tests", "scripts"]
}
```

`exactOptionalPropertyTypes` fica **desligado** (atrito alto com tipos do AWS SDK/MikroORM; benefício pequeno aqui). `useDefineForClassFields: false` evita que campos de classe sobrescrevam propriedades definidas por decorators.

Enums: usar objetos `as const` + tipo união (ex.: `export const LedgerDirection = { Debit: 'DEBIT', Credit: 'CREDIT' } as const; export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];`). Mantém os nomes do enunciado (`WagerTransactionKind.Bet`) sem `enum` do TS.

### 3.3 Scripts do `package.json`

```json
{
  "scripts": {
    "start": "bun src/main.ts",
    "dev": "bun --watch src/main.ts",
    "typecheck": "tsc --noEmit -p .",
    "lint": "biome check src tests scripts",
    "format": "biome format --write src tests scripts",
    "db:migrate": "bun src/infrastructure/persistence/migrate-cli.ts up",
    "db:migrate:down": "bun src/infrastructure/persistence/migrate-cli.ts down",
    "db:migrate:status": "bun src/infrastructure/persistence/migrate-cli.ts status",
    "sqs:setup": "bun scripts/setup-queues.ts",
    "test:reset": "bun scripts/reset-test-db.ts",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test tests/integration --timeout 60000",
    "test:concurrency": "bun test tests/concurrency --timeout 180000",
    "test": "bun run test:unit && bun run test:reset && bun run test:integration && bun run test:concurrency",
    "test:load": "bun scripts/load-test.ts"
  }
}
```

---

## 4. Modelo de domínio

Regra geral (§6.0 do desafio): construtor `private`, factories estáticas (`create`/`open`/`from`), `rehydrate(state)` que **não** revalida transições (apenas reconstrói). Estado mutável em campos `private _x` com getters.

### 4.1 `Money`

```ts
export interface MoneyProps { amount: string; currency: string }

export class Money {
  private constructor(private readonly value: Decimal, public readonly currency: string) {}
  static from(props: MoneyProps): Money;          // contrato de entrada: estrito, não-negativo
  static zero(currency: string): Money;
  add(other: Money): Money;
  subtract(other: Money): Money;                    // pode gerar negativo (uso interno: diferença de reconciliação)
  negate(): Money;
  isZero(): boolean; isPositive(): boolean; isNegative(): boolean;
  isLessThan(other: Money): boolean;                // lança CurrencyMismatchError se moedas diferem
  equals(other: Money): boolean;                    // false se moedas diferem (não lança)
  toJSON(): MoneyProps;                             // { amount: "25.00", currency: "BRL" }
  toString(): string;                               // "25.00 BRL"
  private assertSameCurrency(other: Money): void;
}
```

Implementação:
- `const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 })` local ao módulo (não mutar o `Decimal` global).
- `from`: validar **antes** de construir o Decimal:
  - `amount` deve ser `string` e casar `^(0|[1-9][0-9]{0,14})\.[0-9]{2}$` (exatamente 2 casas; máx. 15 dígitos inteiros; sem sinal, sem notação científica, sem espaços, sem zeros à esquerda). Rejeita `""`, `"NaN"`, `"Infinity"`, `"1e3"`, `"-1.00"`, `"1.005"`, `"25"`, `"25.5"`, `"01.00"`.
  - `currency` deve casar `^[A-Z]{3}$`.
  - Violação → `InvalidMoneyError` (`code = 'INVALID_MONEY'`).
- Nenhuma operação arredonda: `add`/`subtract` de valores com escala 2 permanecem escala 2. Asserção interna `value.decimalPlaces() <= 2`.
- Serialização: `value.toFixed(2)` (negativo vira `"-5.00"`; `-0` deve virar `"0.00"`).
- Moedas diferentes em `add`/`subtract`/`isLessThan` → `CurrencyMismatchError` (domínio).

### 4.2 `Wallet` (aggregate root)

```ts
export interface WalletState { id; playerId; currency; balance: Money; version: number; createdAt: Date; updatedAt: Date }

export class Wallet {
  private constructor(id, playerId, currency, private _balance: Money, private _version: number, createdAt, private _updatedAt: Date) {}

  static open(props: {
    id: string; playerId: string; initialBalance: Money; at: Date;
    opening?: { transactionId: string; entryId: string };   // obrigatório se initialBalance > 0
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined };

  static rehydrate(state: WalletState): Wallet;

  get balance(): Money; get version(): number; get updatedAt(): Date;

  debit(p: { entryId: string; transactionId: string; money: Money; at: Date }): WalletLedgerEntry;
  credit(p: { entryId: string; transactionId: string; money: Money; at: Date }): WalletLedgerEntry;
  canDebit(money: Money): boolean;
  private assertSameCurrency(money: Money): void;
}
```

Regras:
- `open`: `version = 1`. Se `initialBalance > 0`: `balance = initialBalance` e `openingEntry = WalletLedgerEntry.create({ direction: CREDIT, money: initialBalance, balanceBefore: zero, balanceAfter: initialBalance, walletVersion: 1, ... })`. Se zero: sem entry. `initialBalance` negativo é impossível (Money.from), mas validar `!isNegative()`.
- `debit`/`credit`: `money.isPositive()` obrigatório; mesma moeda (`CurrencyMismatchError`); débito com saldo insuficiente → `InsufficientFundsError` (defesa; a policy decide antes). Ambos: `before = balance`, `after = before ± money`, `_version += 1`, `_updatedAt = at`, retornam `WalletLedgerEntry.create({..., walletVersion: novaVersao})`.
- Não existe outro método que altere `_balance` → "toda alteração de saldo tem lançamento" é estrutural.

### 4.3 `WagerTransaction`

Campos (todos `readonly` exceto os `_`):
`id, providerId, externalTransactionId, idempotencyKey, payloadHash, walletId, playerId, roundId, gameId, kind, money, referenceExternalTransactionId?, source ('HTTP'|'SQS'|'INTERNAL'), correlationId?, createdAt`, e mutáveis: `_status, _referenceTransactionId?, _failureCode?, _processedAt?, _resultBalance?: Money, _resultWalletVersion?: number, _referenceAttempts: number, _nextReferenceCheckAt?: Date, _updatedAt: Date`.

```ts
static create(props: CreateWagerTransactionProps): WagerTransaction;       // nasce PENDING
static createOpening(props: { id; walletId; playerId; money; payloadHash; at }): WagerTransaction; // kind OPENING, provider 'internal', source INTERNAL
static rehydrate(state: WagerTransactionState): WagerTransaction;

// transições (lançam InvalidTransactionStateError se inválidas — erro de programação)
markProcessed(p: { referenceTransactionId?: string; at: Date; balanceAfter: Money; walletVersion: number }): void;
markPendingReference(p: { at: Date; nextCheckAt: Date; observedBalance: Money; walletVersion: number }): void;
recordReferenceMiss(p: { at: Date; nextCheckAt: Date }): void;  // só em PENDING_REFERENCE: attempts++, reagenda
reject(p: { code: FailureCode; at: Date; observedBalance?: Money; walletVersion?: number; referenceTransactionId?: string }): void;
fail(p: { code: FailureCode; at: Date }): void;

isTerminal(): boolean;
affectsBalance(): boolean;          // false para LOSS
requiresReference(): boolean;       // REFUND, ROLLBACK
isReversal(): boolean;              // REFUND, ROLLBACK
matchesPayload(hash: string): boolean;
ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection;
```

Validações de `create` (→ `InvalidWagerTransactionError`, mapeado para 400):
- `kind ∈ {BET, WIN, LOSS, REFUND, ROLLBACK}` (OPENING só via `createOpening`);
- REFUND/ROLLBACK exigem `referenceExternalTransactionId`; BET o proíbe; `referenceExternalTransactionId !== externalTransactionId`;
- `money.isPositive()` para BET/WIN/REFUND/ROLLBACK; LOSS aceita `>= 0`;
- `providerId !== 'internal'` (reservado).

Efeitos das transições nos campos (espelham CHECKs do schema — o executor deve respeitá-los exatamente):
- `markProcessed`: `_processedAt = at`; `_nextReferenceCheckAt = undefined`; `_failureCode = undefined`; grava `_resultBalance`/`_resultWalletVersion`; para REFUND/ROLLBACK `referenceTransactionId` é obrigatório (lança se ausente).
- `reject`/`fail`: `_failureCode = code`; `_processedAt` permanece `undefined` (somente PROCESSED tem `processed_at`); `_nextReferenceCheckAt = undefined`.
- `markPendingReference`/`recordReferenceMiss`: `_nextReferenceCheckAt` sempre definido.
- Toda transição atualiza `_updatedAt = at`.

`ledgerDirectionFor`: BET→DEBIT; WIN/REFUND/OPENING→CREDIT; ROLLBACK→inverso de `reference.ledgerDirectionFor()` (exige reference, senão lança); LOSS→lança (não afeta saldo).

### 4.4 `WalletLedgerEntry` (imutável)

Campos todos `public readonly`: `id, walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion, createdAt`. Sem setters, sem métodos de transição.
- `create(props)`: valida `money.isPositive()`, moedas iguais nos três `Money`, `balanceBefore`/`balanceAfter` não negativos, `walletVersion >= 1` e `isBalanced()`; senão `InvalidLedgerEntryError`.
- `isBalanced()`: CREDIT → `before.add(money).equals(after)`; DEBIT → `before.subtract(money).equals(after)`.
- `rehydrate(state)`: sem validação.

### 4.5 `WagerPolicy` (serviço de domínio puro)

```ts
export type WagerDecision =
  | { type: 'APPLY'; direction: LedgerDirection; referenceTransactionId?: string }
  | { type: 'RECORD_ONLY'; referenceTransactionId?: string }         // LOSS
  | { type: 'REJECT'; failureCode: FailureCode; referenceTransactionId?: string; exposeBalance: boolean }
  | { type: 'AWAIT_REFERENCE' };

export class WagerPolicy {
  static decide(input: {
    transaction: WagerTransaction;        // em PENDING ou PENDING_REFERENCE
    wallet: Wallet;                       // travada
    reference: WagerTransaction | null;   // resolvida por (providerId, referenceExternalTransactionId)
    referenceAlreadyReversed: boolean;    // existe REFUND/ROLLBACK PROCESSED apontando para reference.id
  }): WagerDecision;
}
```

Ordem exata das verificações (a primeira que falhar decide):

1. `wallet.playerId !== tx.playerId` → `REJECT WALLET_PLAYER_MISMATCH` (`exposeBalance=false`).
2. `tx.money.currency !== wallet.currency` → `REJECT CURRENCY_MISMATCH` (`exposeBalance=false`).
3. Se `tx.referenceExternalTransactionId` definido:
   1. `reference === null` → `AWAIT_REFERENCE`.
   2. `reference.walletId !== tx.walletId || reference.playerId !== tx.playerId || reference.money.currency !== tx.money.currency || reference.roundId !== tx.roundId` → `REJECT REFERENCE_MISMATCH`. (provider é igual por construção da busca.)
   3. Compatibilidade de tipo (senão `REJECT INVALID_REFERENCE_KIND`):
      - REFUND → {BET}
      - ROLLBACK → {BET, WIN, REFUND}
      - WIN → {BET}
      - LOSS → {BET}
   4. `reference.status ∈ {PENDING, PENDING_REFERENCE}` → `AWAIT_REFERENCE` (cadeia fora de ordem).
   5. `reference.status ∈ {REJECTED, FAILED}` → `REJECT REFERENCE_NOT_PROCESSED`.
   6. Se `tx.isReversal()` e `!tx.money.equals(reference.money)` → `REJECT AMOUNT_MISMATCH`.
   7. Se `tx.isReversal()` e `referenceAlreadyReversed` → `REJECT ALREADY_REVERSED`.
4. `kind === LOSS` → `RECORD_ONLY`.
5. `direction = tx.ledgerDirectionFor(reference ?? undefined)`.
6. Se `direction === DEBIT` e `!wallet.canDebit(tx.money)` → BET: `REJECT INSUFFICIENT_FUNDS`; ROLLBACK: `REJECT REVERSAL_INSUFFICIENT_FUNDS`.
7. `APPLY { direction, referenceTransactionId: reference?.id }`.

`exposeBalance = true` para todos os REJECT exceto os itens 1 e 2.

---

## 5. Máquina de estados e taxonomia de falhas

### 5.1 Transições de `WagerTransaction`

```mermaid
stateDiagram-v2
  [*] --> PENDING: create()
  PENDING --> PROCESSED: markProcessed
  PENDING --> REJECTED: reject
  PENDING --> PENDING_REFERENCE: markPendingReference
  PENDING --> FAILED: fail
  PENDING_REFERENCE --> PENDING_REFERENCE: recordReferenceMiss (attempts++)
  PENDING_REFERENCE --> PROCESSED: markProcessed
  PENDING_REFERENCE --> REJECTED: reject (inclui REFERENCE_NOT_FOUND na expiração)
  PENDING_REFERENCE --> FAILED: fail
  PROCESSED --> [*]
  REJECTED --> [*]
  FAILED --> [*]
```

- `PENDING` é transitório **em memória**: a linha é inserida já no estado resultante (PROCESSED/REJECTED/PENDING_REFERENCE) dentro da mesma transação SQL. O schema aceita `PENDING` para evolução futura (aceite assíncrono).
- Qualquer chamada de transição a partir de estado terminal, ou `recordReferenceMiss` fora de PENDING_REFERENCE → `InvalidTransactionStateError` (bug, não caminho de negócio).
- O trigger `wager_tx_guard` replica essas regras no banco (§6.8).
- `OPENING` nasce e é persistido como `PROCESSED`.

### 5.2 `FailureCode`

`retryable` = "reenviar **a mesma** requisição pode produzir resultado diferente?". Para toda rejeição persistida a resposta é **não**: a idempotency key fica ligada ao resultado; o provedor deve corrigir e enviar uma **nova** transação (novo `externalTransactionId`/key).

| Código | Status | Quando | retryable | Ação esperada do provedor |
|---|---|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | BET maior que o saldo | false | desistir / nova aposta |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | ROLLBACK (de WIN/REFUND) levaria saldo < 0 | false | intervenção operacional |
| `CURRENCY_MISMATCH` | REJECTED | moeda ≠ moeda da wallet | false | corrigir payload |
| `WALLET_PLAYER_MISMATCH` | REJECTED | wallet não pertence ao `playerId` | false | corrigir payload |
| `REFERENCE_NOT_FOUND` | REJECTED | referência não chegou dentro da janela de retry (§10) | false | investigar; reenviar com nova key |
| `REFERENCE_MISMATCH` | REJECTED | referência de outra wallet/player/moeda/rodada | false | corrigir payload |
| `INVALID_REFERENCE_KIND` | REJECTED | tipo referenciado incompatível (ex.: REFUND→WIN) | false | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | REJECTED | referência está REJECTED/FAILED | false | desistir |
| `ALREADY_REVERSED` | REJECTED | referência já revertida por REFUND/ROLLBACK PROCESSED | false | desistir (já revertido) |
| `AMOUNT_MISMATCH` | REJECTED | valor da reversão ≠ valor da referência | false | corrigir payload |
| `PROCESSING_ERROR` | FAILED | erro permanente inesperado ao resolver PENDING_REFERENCE (§10.4) | false | contato operacional |
| `WALLET_NOT_FOUND` | (não persistido) | `walletId` inexistente — não há FK alvo para persistir | false | corrigir payload |

Erros de API que **não** são `FailureCode` (não persistem transação): `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS`, `WALLET_NOT_FOUND` (GET), `TRANSACTION_NOT_FOUND`, `INVALID_CURSOR`, `UNAUTHORIZED`, `FORBIDDEN`, `TRANSIENT_FAILURE`, `INTERNAL_ERROR`.

---

## 6. Portas, persistência e schema

### 6.1 Unit of Work

```ts
// application/ports/unit-of-work.ts
export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}
export interface UnitOfWorkOptions { isolation?: 'READ_COMMITTED' | 'REPEATABLE_READ' }
export interface UnitOfWork {
  /** Executa `work` em UMA transação SQL. Commit se resolver, rollback se lançar.
   *  Erros de banco são traduzidos (pg-error-classifier) para erros de aplicação. */
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
```

### 6.2 Repositórios (todos ligados ao `EntityManager` da transação)

```ts
interface WalletRepository {
  findByIdForUpdate(id: string): Promise<Wallet | null>;      // SELECT ... FOR UPDATE
  insert(wallet: Wallet): Promise<void>;
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>; // UPDATE ... WHERE id=? AND version=?; affected!==1 → ConcurrencyInvariantError
}
interface WagerTransactionRepository {
  findForIdempotency(key: string, providerId: string, externalId: string): Promise<WagerTransaction[]>; // WHERE idempotency_key=? OR (provider_id=? AND external_transaction_id=?)
  findByProviderExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;     // INSERT ... ON CONFLICT DO NOTHING RETURNING id
  update(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void>; // WHERE id=? AND status=?; affected!==1 → ConcurrencyInvariantError
  claimDuePendingReferences(limit: number, leaseMs: number): Promise<Array<{ id: string; walletId: string }>>;
  nudgeAwaiting(providerId: string, externalId: string, walletId: string): Promise<number>;
}
interface LedgerRepository { append(entry: WalletLedgerEntry): Promise<void> }
interface InboxRepository {
  tryReceive(msg: InboxMessage): Promise<'RECEIVED' | 'DUPLICATE'>; // INSERT ... ON CONFLICT DO NOTHING
  markProcessed(msg: InboxMessage, transactionId: string | null): Promise<void>;
}
interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(ids: string[], at: Date): Promise<void>;
  saveRetry(message: OutboxMessage, error: string): Promise<void>;
}
```

`claimDue`, `markPublished` e `saveRetry` são chamados cada um em sua própria `uow.run` curta (§13).

### 6.3 Read models (fora de transação de escrita)

```ts
// application/ports/read-models.ts
interface WalletView { id; playerId; balance: MoneyProps; version: number; createdAt: string; updatedAt: string }
interface LedgerEntryView { id; transactionId; direction; money: MoneyProps; balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number; createdAt: string }
interface WagerTransactionView { transactionId; providerId; externalTransactionId; idempotencyKey; walletId; playerId; roundId; gameId; kind; money: MoneyProps;
  referenceExternalTransactionId: string | null; referenceTransactionId: string | null; status; failureCode: string | null;
  balanceAfter: MoneyProps | null; walletVersion: number | null; createdAt; updatedAt; processedAt: string | null }
interface ReconciliationSnapshot { wallet: { id; currency; balance: string; version: number };
  ledgerSum: string; entries: number; lastEntry: { walletVersion: number; balanceAfter: string } | null; chainBreaks: number }

interface WalletReadModel { getById(id: string): Promise<WalletView | null> }
interface LedgerReadModel { page(walletId: string, afterVersion: number, limit: number): Promise<LedgerEntryView[]> }
interface WagerTransactionReadModel { getById(id: string): Promise<WagerTransactionView | null>; getByProviderExternalId(p: string, e: string): Promise<WagerTransactionView | null> }
interface ReconciliationReadModel { snapshot(walletId: string): Promise<ReconciliationSnapshot | null> }
interface OperationalGaugesReadModel { outboxPending(): Promise<{ count: number; oldestAgeSeconds: number }>; pendingReferences(): Promise<number> }
```

### 6.4 Outras portas

```ts
interface Clock { now(): Date }
interface IdGenerator { next(): string }                         // uuid v7
interface MessagePublisher { publishBatch(msgs: OutboxMessage[]): Promise<Array<{ id: string; ok: boolean; error?: string }>> }
interface LoggerPort { child(bindings: Record<string, unknown>): LoggerPort; debug/info/warn/error(obj: object, msg: string): void }
interface ProviderIdentityPort { resolve(authorizationHeader: string | undefined): Promise<ProviderIdentity> }
type ProviderIdentity = { kind: 'anonymous' } | { kind: 'provider'; providerId: string; subject: string }
interface FaultInjector { afterCommit(point: 'sqs-before-ack', key: string): void; afterOutboxClaim(): void; delayInTransaction(): Promise<void>; transientFailure(key: string): boolean }
interface MetricsPort { /* métodos semânticos — lista em §14.2 */ }
```

### 6.5 Erros de aplicação (`application/errors.ts`)

| Classe | Uso | HTTP |
|---|---|---|
| `ValidationError(details)` | payload inválido (zod ou domínio `InvalidMoneyError`/`InvalidWagerTransactionError`) | 400 |
| `NotFoundError(code)` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` em GETs | 404 |
| `WalletAlreadyExistsError` | unique `wallets_player_currency_uk` | 409 |
| `TransientInfrastructureError(reason)` | após esgotar retry interno | 503 + `Retry-After: 1` |
| `UniqueViolationError(constraint)` | 23505 traduzido pelo classifier (interno) | — |
| `IntegrityViolationError(detail)` | 23xxx exceto 23505 (bug/defesa de schema) | 500 |
| `ConcurrencyInvariantError` | update com `affected !== 1` sob lock (bug) | 500 |
| `IdempotencyRaceError` | `insertIfAbsent` retornou false (interno, provoca retry) | — |

`IDEMPOTENCY_CONFLICT` e `WALLET_NOT_FOUND` (na submissão) **não** são exceções: são resultados do use case (§8.4).

### 6.6 Tokens de DI (`bootstrap/tokens.ts`)

`APP_CONFIG, MIKRO_ORM, UNIT_OF_WORK, WALLET_READ_MODEL, LEDGER_READ_MODEL, WAGER_TX_READ_MODEL, RECONCILIATION_READ_MODEL, GAUGES_READ_MODEL, MESSAGE_PUBLISHER, CLOCK, ID_GENERATOR, METRICS, LOGGER, PROVIDER_IDENTITY, SQS_CLIENT, QUEUE_REGISTRY, FAULT_INJECTOR, HEALTH_CHECKER, PROM_REGISTRY`. Use cases usam a própria classe como token (`{ provide: ProcessWagerTransactionUseCase, useFactory: (...) => new ProcessWagerTransactionUseCase(...), inject: [...] }`).

### 6.7 MikroORM

`createOrm(config)`:

```ts
MikroORM.init({
  clientUrl: config.databaseUrl,
  entities: [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxMessageSchema, OutboxMessageSchema],
  extensions: [Migrator],
  pool: { min: 0, max: config.dbPoolMax },
  migrations: { migrationsList, tableName: 'mikro_orm_migrations', transactional: true, allOrNothing: true, snapshot: false },
  debug: false,
  allowGlobalContext: false,
});
```

- **EntitySchema** (sem decorators) sobre interfaces de *record* planas (ex.: `interface WalletRecord { id: string; playerId: string; currency: string; balance: string; version: number; createdAt: Date; updatedAt: Date }`). Tipos: `uuid`, `decimal` (precision 20, scale 2 → string), `datetime` com `columnType: 'timestamptz'`, `json` com `columnType: 'jsonb'`, `string`/`text`. O naming strategy padrão mapeia camelCase → snake_case. Records ≠ entidades de domínio; mappers fazem `rehydrate`.
- O schema generator do MikroORM **não** é usado; o schema vem exclusivamente das migrations SQL.
- `MikroUnitOfWork.run`:
  ```ts
  const em = orm.em.fork();
  return await em.transactional(async (tx) => {
    await tx.execute(`select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`,
                     [`${cfg.dbLockTimeoutMs}ms`, `${cfg.dbStatementTimeoutMs}ms`]);
    return work(buildScope(tx));     // repositórios instanciados com `tx`
  }, { isolationLevel: options?.isolation === 'REPEATABLE_READ' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED });
  ```
  envolvido em `try/catch` que relança `classifyDatabaseError(err)` (o constraint trigger diferido dispara no COMMIT — também é capturado aqui).
- Leituras com lock: `em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE })`.
- Escritas: `em.insert(Schema, record)` para inserts simples; `em.nativeUpdate(Schema, where, data)` para updates com predicado de versão/status; `em.execute(sql, params)` (placeholders `?`) apenas para: `ON CONFLICT DO NOTHING RETURNING`, claims com `SKIP LOCKED`, agregações, `set_config`. Não usar `persist/flush` (Unit of Work do MikroORM é substituído pela nossa UoW explícita; evita sincronização implícita de identity map com objetos de domínio separados).

### 6.8 Schema SQL (migrations)

**Validado** em `postgres:16-alpine`: `up` → bateria de casos negativos (todos rejeitados com o erro esperado) → `down` → `up` novamente sem erros.

Cada migration é uma classe `extends Migration` (de `@mikro-orm/migrations`) com `override async up()` e `override async down()`, chamando `this.addSql(...)` **uma vez por statement** (cada `CREATE FUNCTION` em uma chamada própria). Corpos plpgsql com `$$` funcionam em template literal (não usar `${`). Nomes: `Migration20261029000001CoreTables`, `Migration20261029000002IntegrityTriggers`, `Migration20261029000003Messaging`; `migrations/index.ts` exporta `migrationsList = [{ name, class }, ...]` nessa ordem.

#### Migration 1 — `CoreTables` (up)

```sql
CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   uuid          NOT NULL,
  currency    char(3)       NOT NULL,
  balance     numeric(20,2) NOT NULL,
  version     integer       NOT NULL,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT wallets_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
  CONSTRAINT wallets_version_positive_ck CHECK (version >= 1),
  CONSTRAINT wallets_player_currency_uk UNIQUE (player_id, currency),
  CONSTRAINT wallets_id_currency_uk UNIQUE (id, currency)
);

CREATE TABLE wager_transactions (
  id                                 uuid          PRIMARY KEY,
  provider_id                        text          NOT NULL,
  external_transaction_id            text          NOT NULL,
  idempotency_key                    text          NOT NULL,
  payload_hash                       char(64)      NOT NULL,
  wallet_id                          uuid          NOT NULL REFERENCES wallets(id),
  player_id                          uuid          NOT NULL,
  round_id                           text          NOT NULL,
  game_id                            text          NOT NULL,
  kind                               text          NOT NULL,
  amount                             numeric(20,2) NOT NULL,
  currency                           char(3)       NOT NULL,
  reference_external_transaction_id  text          NULL,
  reference_transaction_id           uuid          NULL REFERENCES wager_transactions(id),
  status                             text          NOT NULL,
  failure_code                       text          NULL,
  result_balance_amount              numeric(20,2) NULL,
  result_wallet_version              integer       NULL,
  reference_attempts                 integer       NOT NULL DEFAULT 0,
  next_reference_check_at            timestamptz   NULL,
  source                             text          NOT NULL,
  correlation_id                     text          NULL,
  created_at                         timestamptz   NOT NULL,
  updated_at                         timestamptz   NOT NULL,
  processed_at                       timestamptz   NULL,
  CONSTRAINT wager_tx_kind_ck   CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT wager_tx_status_ck CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT wager_tx_source_ck CHECK (source IN ('HTTP','SQS','INTERNAL')),
  CONSTRAINT wager_tx_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_tx_amount_ck CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
  CONSTRAINT wager_tx_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wager_tx_reference_required_ck CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_reference_forbidden_ck CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
  CONSTRAINT wager_tx_not_self_reference_ck CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
  CONSTRAINT wager_tx_failure_code_ck CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT wager_tx_processed_at_ck CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
  CONSTRAINT wager_tx_processed_reversal_ref_ck CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_pending_ref_ck CHECK ((status = 'PENDING_REFERENCE') = (next_reference_check_at IS NOT NULL)),
  CONSTRAINT wager_tx_reference_attempts_ck CHECK (reference_attempts >= 0),
  CONSTRAINT wager_tx_result_version_ck CHECK (result_wallet_version IS NULL OR result_wallet_version >= 1),
  CONSTRAINT wager_tx_opening_internal_ck CHECK ((kind = 'OPENING') = (source = 'INTERNAL')),
  CONSTRAINT wager_tx_idempotency_key_uk UNIQUE (idempotency_key),
  CONSTRAINT wager_tx_provider_external_uk UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_tx_id_wallet_uk UNIQUE (id, wallet_id)
);
-- Regra 4 (interpretação estrita, §22): uma referência só pode ter UMA reversão PROCESSED (REFUND ou ROLLBACK)
CREATE UNIQUE INDEX wager_tx_single_reversal_uk ON wager_transactions (reference_transaction_id)
  WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
CREATE INDEX wager_tx_pending_reference_due_ix ON wager_transactions (next_reference_check_at)
  WHERE status = 'PENDING_REFERENCE';
CREATE INDEX wager_tx_awaiting_reference_ix ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';
CREATE INDEX wager_tx_reference_ix ON wager_transactions (reference_transaction_id) WHERE reference_transaction_id IS NOT NULL;
CREATE INDEX wager_tx_wallet_created_ix ON wager_transactions (wallet_id, created_at);

CREATE TABLE wallet_ledger_entries (
  id              uuid          PRIMARY KEY,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  direction       text          NOT NULL,
  amount          numeric(20,2) NOT NULL,
  currency        char(3)       NOT NULL,
  balance_before  numeric(20,2) NOT NULL,
  balance_after   numeric(20,2) NOT NULL,
  wallet_version  integer       NOT NULL,
  created_at      timestamptz   NOT NULL,
  CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
  CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id),
  CONSTRAINT ledger_direction_ck CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
  CONSTRAINT ledger_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT ledger_arithmetic_ck CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount)),
  CONSTRAINT ledger_wallet_version_ck CHECK (wallet_version >= 1),
  CONSTRAINT ledger_wallet_transaction_uk UNIQUE (wallet_id, transaction_id),
  CONSTRAINT ledger_wallet_version_uk UNIQUE (wallet_id, wallet_version)
);
CREATE INDEX ledger_transaction_ix ON wallet_ledger_entries (transaction_id);
```

Down: `DROP TABLE wallet_ledger_entries; DROP TABLE wager_transactions; DROP TABLE wallets;` (nessa ordem, com `IF EXISTS`).

Notas de desenho:
- `UNIQUE (wallet_id, wallet_version)` no ledger: cada versão da wallet tem no máximo um lançamento → impossível dois lançamentos "concorrentes" sobre a mesma versão (lost update detectado no banco). Também é o índice usado pela paginação por cursor.
- FKs compostas garantem que o lançamento tem a **moeda da wallet** e pertence à **mesma wallet da transação**.
- `wager_transactions.currency` **não** tem FK para a moeda da wallet porque transações `CURRENCY_MISMATCH` precisam ser persistidas (auditáveis).

#### Migration 2 — `IntegrityTriggers` (up)

```sql
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden (append-only)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER ledger_forbid_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_forbid_truncate BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION ledger_enforce_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev_after numeric(20,2);
BEGIN
  IF EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id AND wallet_version > NEW.wallet_version) THEN
    RAISE EXCEPTION 'ledger entry out of order for wallet %', NEW.wallet_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT balance_after INTO prev_after FROM wallet_ledger_entries
   WHERE wallet_id = NEW.wallet_id AND wallet_version < NEW.wallet_version
   ORDER BY wallet_version DESC LIMIT 1;
  IF COALESCE(prev_after, 0) <> NEW.balance_before THEN
    RAISE EXCEPTION 'ledger chain broken for wallet % (expected before=%, got %)', NEW.wallet_id, COALESCE(prev_after, 0), NEW.balance_before
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_enforce_chain BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_enforce_chain();

CREATE FUNCTION wallets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'immutable wallet column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'wallet version must increment by exactly 1 when balance changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'wallet version may only change together with balance' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallets_guard_update BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION wallets_guard_update();
CREATE TRIGGER wallets_forbid_delete BEFORE DELETE ON wallets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Constraint trigger DIFERIDO: no COMMIT, todo saldo de wallet tem de estar "lastreado" pelo último lançamento.
CREATE FUNCTION wallets_assert_ledger_backed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_balance numeric(20,2); current_version integer;
BEGIN
  SELECT balance, version INTO current_balance, current_version FROM wallets WHERE id = NEW.id;
  IF current_balance = 0 AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE wallet_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM wallet_ledger_entries
     WHERE wallet_id = NEW.id AND wallet_version = current_version AND balance_after = current_balance) THEN
    RAISE EXCEPTION 'wallet % balance % (version %) is not backed by a ledger entry', NEW.id, current_balance, current_version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallets_ledger_backed AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallets_assert_ledger_backed();

CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager_transactions rows cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))
    OR (OLD.status = 'PENDING_REFERENCE' AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))) THEN
    RAISE EXCEPTION 'invalid wager transaction transition % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id, NEW.player_id,
      NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency, NEW.reference_external_transaction_id, NEW.source, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id, OLD.player_id,
      OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency, OLD.reference_external_transaction_id, OLD.source, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable wager transaction column changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wager_tx_guard BEFORE UPDATE OR DELETE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION wager_tx_guard();
```

Down (ordem):
```sql
DROP TRIGGER IF EXISTS wager_tx_guard ON wager_transactions;
DROP FUNCTION IF EXISTS wager_tx_guard();
DROP TRIGGER IF EXISTS wallets_ledger_backed ON wallets;
DROP FUNCTION IF EXISTS wallets_assert_ledger_backed();
DROP TRIGGER IF EXISTS wallets_forbid_delete ON wallets;
DROP TRIGGER IF EXISTS wallets_guard_update ON wallets;
DROP FUNCTION IF EXISTS wallets_guard_update();
DROP TRIGGER IF EXISTS ledger_enforce_chain ON wallet_ledger_entries;
DROP FUNCTION IF EXISTS ledger_enforce_chain();
DROP TRIGGER IF EXISTS ledger_forbid_truncate ON wallet_ledger_entries;
DROP TRIGGER IF EXISTS ledger_forbid_update_delete ON wallet_ledger_entries;
DROP FUNCTION IF EXISTS forbid_mutation();
```

Todos os erros de trigger usam SQLSTATE `23000` → classificados como `IntegrityViolationError` (permanente).

#### Migration 3 — `Messaging` (up)

```sql
CREATE TABLE inbox_messages (
  consumer_name  text        NOT NULL,
  message_id     text        NOT NULL,
  payload_hash   char(64)    NOT NULL,
  transaction_id uuid        NULL,
  received_at    timestamptz NOT NULL,
  processed_at   timestamptz NULL,
  CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id),
  CONSTRAINT inbox_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inbox_processed_after_received_ck CHECK (processed_at IS NULL OR processed_at >= received_at)
);
CREATE TABLE outbox_messages (
  id               uuid        PRIMARY KEY,           -- = eventId
  aggregate_type   text        NOT NULL,              -- 'WagerTransaction' | 'Wallet'
  aggregate_id     text        NOT NULL,
  partition_key    text        NOT NULL,              -- walletId → MessageGroupId
  event_type       text        NOT NULL,
  event_version    integer     NOT NULL,
  payload          jsonb       NOT NULL,              -- envelope completo (IntegrationEvent.toJSON())
  correlation_id   text        NOT NULL,
  causation_id     text        NULL,
  occurred_at      timestamptz NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL,
  published_at     timestamptz NULL,
  last_error       text        NULL,
  CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
  CONSTRAINT outbox_event_version_ck CHECK (event_version >= 1),
  CONSTRAINT outbox_payload_object_ck CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX outbox_due_ix ON outbox_messages (next_attempt_at, occurred_at) WHERE published_at IS NULL;
CREATE INDEX outbox_pending_occurred_ix ON outbox_messages (occurred_at) WHERE published_at IS NULL;
```

Down: `DROP TABLE IF EXISTS outbox_messages; DROP TABLE IF EXISTS inbox_messages;`

#### Mapa §5.9 do desafio → schema

| Garantia | Onde |
|---|---|
| 1 wallet por player+moeda | `wallets_player_currency_uk` |
| saldo ≥ 0 | `wallets_balance_non_negative_ck`, `ledger_balances_non_negative_ck` |
| idempotência | `wager_tx_idempotency_key_uk`, `wager_tx_provider_external_uk` |
| ≤ 1 lançamento por transação/wallet | `ledger_wallet_transaction_uk` |
| aritmética do lançamento | `ledger_arithmetic_ck` |
| ledger imutável | triggers `ledger_forbid_update_delete`, `ledger_forbid_truncate` |
| ledger encadeado / sem lost update | `ledger_wallet_version_uk` + `ledger_enforce_chain` |
| saldo ⇔ ledger | constraint trigger diferido `wallets_ledger_backed` |
| `version` só muda com saldo, +1 | `wallets_guard_update`, `wallets_version_positive_ck` |
| reversão única | `wager_tx_single_reversal_uk` (parcial) |
| estados terminais imutáveis | `wager_tx_guard` |
| enums | CHECKs de `kind`, `status`, `source`, `direction` |
| inbox dedup | PK `(consumer_name, message_id)` |
| outbox polling | `outbox_due_ix`, `outbox_pending_occurred_ix` (parciais) |

---

## 7. Estratégia de concorrência

### 7.1 Decisão

**Lock pessimista por linha de wallet** (`SELECT … FROM wallets WHERE id = $1 FOR UPDATE`) no início de toda transação que lê-decide-escreve sobre uma wallet, em `READ COMMITTED`, com:
- `version` incrementada e verificada no `UPDATE … WHERE id = ? AND version = ?` (defesa adicional; sob lock deve sempre afetar 1 linha);
- `lock_timeout = DB_LOCK_TIMEOUT_MS` (default 5000) e `statement_timeout = DB_STATEMENT_TIMEOUT_MS` (default 15000) via `set_config(..., true)` (escopo da transação);
- constraints/triggers (§6.8) como última linha de defesa.

Não existe lock global: o único lock de negócio é a linha da wallet afetada. Wallets diferentes processam em paralelo sem contenção.

### 7.2 Por que não otimista

Com optimistic locking, a "hot wallet" (50 requisições simultâneas na mesma wallet, cenário obrigatório 1) gera N-1 conflitos por rodada, retries em cascata e esgotamento do limite de retries → falhas espúrias para o provedor. O lock pessimista serializa somente quem disputa a mesma linha, com custo de espera de poucos ms por transação. Em `READ COMMITTED`, após obter o lock o Postgres re-lê a versão mais recente da linha, e todos os `SELECT` seguintes na transação veem os commits anteriores — por isso a checagem de idempotência é feita **após** o lock (§8.3 passo 4). `SERIALIZABLE` foi descartado: aborts por falso-positivo sem ganho, dado que todas as invariantes por wallet já estão sob o lock.

### 7.3 Ordem de locks e deadlocks

Ordem canônica em qualquer transação de escrita:
1. (SQS) linha de `inbox_messages` (INSERT);
2. linha da `wallets` (`FOR UPDATE`) — **exatamente uma wallet** por transação;
3. linhas de `wager_transactions` (INSERT da nova, ou `FOR UPDATE` da pendente no worker);
4. INSERT em `wallet_ledger_entries` e `outbox_messages`.

Como nenhuma transação trava duas wallets e todas seguem a mesma ordem, não há ciclo possível entre transações de negócio. Claims de outbox/pending são transações separadas e curtas (não seguram wallet). Deadlocks residuais (40P01) são tratados como transitórios.

`pg-error-classifier.ts` — classificação por `err.code`:

| Classe | SQLSTATE / erro | Tradução |
|---|---|---|
| Transitório (retry) | `40001`, `40P01`, `55P03`, `57014`, `57P01`, `57P02`, `57P03`, `53300`, `53400`, classe `08xxx`; erros de socket `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`; mensagens do pool `timeout exceeded when trying to connect`, `Connection terminated` | `TransientDatabaseError(reason)` com `reason ∈ {serialization, deadlock, lock_timeout, statement_timeout, connection}` |
| Unicidade | `23505` | `UniqueViolationError(err.constraint)` |
| Integridade | demais `23xxx` (`23514`, `23503`, `23000` de trigger) | `IntegrityViolationError` (permanente) |
| Outros | — | relança original (permanente/desconhecido) |

### 7.4 Política de retry interno (`withTransientRetry`)

- Envolve **a execução inteira do use case** (nova transação a cada tentativa; nada é reaproveitado entre tentativas).
- Retenta: `TransientDatabaseError`, `IdempotencyRaceError`, `UniqueViolationError` com constraint `wager_tx_single_reversal_uk` / `wager_tx_idempotency_key_uk` / `wager_tx_provider_external_uk` / `inbox_messages_pk` (corridas que, na nova tentativa, viram replay/rejeição determinística).
- `TX_MAX_ATTEMPTS = 3` tentativas no total; espera `min(25ms · 2^(n-1), 200ms) + jitter uniforme [0, 25ms)`.
- Esgotado: lança `TransientInfrastructureError(reason)` → HTTP 503 / SQS backoff de visibilidade.
- Métricas: cada retry incrementa `wagering_processing_retries_total{operation, reason}`; `lock_timeout`/`deadlock`/`serialization` incrementam também `wagering_lock_conflicts_total{reason}`. O tempo de espera do `FOR UPDATE` é medido em `wagering_wallet_lock_wait_seconds`.

### 7.5 Pool e timeouts

- `DB_POOL_MAX=20` por instância (testes: 10). Postgres no compose com `max_connections=200`.
- 50 requisições simultâneas na mesma wallet ficam enfileiradas no lock (≈ 5–10 ms cada) — bem abaixo de `lock_timeout=5s`.

---

## 8. Algoritmo do `ProcessWagerTransaction` (HTTP e SQS)

### 8.1 Comando

```ts
export type CommandSource =
  | { type: 'HTTP'; requestId: string }
  | { type: 'SQS'; consumerName: string; messageId: string; messageHash: string };

export interface ProcessWagerCommand {
  idempotencyKey: string;
  providerId: string; externalTransactionId: string;
  playerId: string; walletId: string; roundId: string; gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  source: CommandSource;
}
```

O corpo HTTP e o `data` do envelope SQS são validados pelo **mesmo** schema zod (`interface/shared/wager-request.schema.ts`):

| Campo | Regra |
|---|---|
| `providerId` | `^[A-Za-z0-9._-]{1,64}$`, ≠ `internal` |
| `externalTransactionId`, `referenceExternalTransactionId` | string 1..128, `^[\x21-\x7E]+$` (ASCII imprimível sem espaço) |
| `playerId`, `walletId` | `z.uuid()` |
| `roundId`, `gameId` | string 1..128, `^[\x21-\x7E]+$` |
| `kind` | `BET|WIN|LOSS|REFUND|ROLLBACK` (`OPENING` → 400) |
| `money.amount` | string, regex de §4.1 (número JSON → 400) |
| `money.currency` | `^[A-Z]{3}$` |
| regras cruzadas | REFUND/ROLLBACK exigem referência; BET a proíbe; referência ≠ externalTransactionId; amount > 0 exceto LOSS |
| campos desconhecidos | descartados (`z.object`, strip) e fora do hash |
| `Idempotency-Key` (HTTP header) / `data.idempotencyKey` (SQS) | obrigatório, `^[\x21-\x7E]{1,255}$` |

### 8.2 `payloadHash` (algoritmo documentado)

1. Montar o objeto com **exatamente** estes 9 campos de negócio (nada de header, `idempotencyKey`, `messageId`, `correlationId`, timestamps):
   `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount, currency}, referenceExternalTransactionId`
   — `referenceExternalTransactionId` ausente é representado como `null` (ausente ≡ null).
2. Os valores já estão normalizados pela validação (amount com 2 casas, currency maiúscula); **não** transformar strings (sem trim/lowercase).
3. `canonicalJson`: serialização recursiva com chaves ordenadas por ordem de code unit (`Object.keys(o).sort()`), sem espaços, strings/números via `JSON.stringify`, `null` literal, arrays na ordem original.
4. `payloadHash = sha256(utf8(canonicalJson)).hex` (minúsculo, 64 chars), via `node:crypto` `createHash('sha256')`.

**Vetor de teste** (deve existir em `tests/unit/application/payload-hash.test.ts`): o payload do exemplo do desafio (`BET 25.00 BRL`, `provider-a`/`transaction-123`, sem referência) produz o JSON canônico

```
{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","referenceExternalTransactionId":null,"roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}
```

e o hash `6ff120b653ab29c549944171b99b9bd2781fd142504011f05029c37c3d9c8974`.

Hash do inbox: `sha256(rawSqsBody)` (string exata recebida).

### 8.3 Passo a passo

```mermaid
sequenceDiagram
  participant E as HTTP/SQS
  participant UC as ProcessWagerTransaction
  participant DB as PostgreSQL (1 transação)
  E->>UC: command
  UC->>UC: payloadHash
  UC->>DB: BEGIN; set_config(lock_timeout, statement_timeout)
  opt source = SQS
    UC->>DB: INSERT inbox ON CONFLICT DO NOTHING
    DB-->>UC: duplicate? → COMMIT, DUPLICATE_MESSAGE
  end
  UC->>DB: SELECT wallet FOR UPDATE
  UC->>DB: SELECT tx WHERE idempotency_key OR (provider, externalId)
  alt já existe
    UC-->>E: replay (mesmo hash e key) ou IDEMPOTENCY_CONFLICT
  else nova
    UC->>DB: SELECT referência + hasProcessedReversal
    UC->>UC: WagerPolicy.decide → aplica no domínio
    UC->>DB: INSERT tx ON CONFLICT DO NOTHING (0 linhas → IdempotencyRaceError → retry)
    UC->>DB: UPDATE wallet (version), INSERT ledger
    UC->>DB: INSERT outbox (eventos)
    UC->>DB: UPDATE inbox processed_at (SQS)
    UC->>DB: COMMIT (constraint trigger diferido valida saldo⇔ledger)
  end
  UC-->>E: result
```

Dentro de `withTransientRetry` (§7.4), cada tentativa executa `uow.run(async (s) => { ... })` com:

0. `now = clock.now()`; `hash = computeWagerPayloadHash(cmd)`; `startedAt` para métrica de latência.
1. **Inbox (somente SQS):** `InboxMessage.receive({ consumerName, messageId, payloadHash: messageHash, receivedAt: now })`; `s.inbox.tryReceive(msg)`.
   - `DUPLICATE` → métrica `duplicates{source="sqs", type="inbox"}`; se o hash do inbox existente diferir, log `warn` (messageId reutilizado com corpo diferente). Retornar `{ outcome: 'DUPLICATE_MESSAGE' }` (commit sem efeitos).
   - Inserção concorrente com o mesmo `(consumer, messageId)` bloqueia até a outra transação terminar (comportamento do `ON CONFLICT`); se ela commitou → `DUPLICATE`.
2. `faultInjector.delayInTransaction()` (no-op em produção; usado em testes de shutdown/lock).
3. **Lock:** `t0 = now(); wallet = s.wallets.findByIdForUpdate(cmd.walletId)`; observar `wallet_lock_wait_seconds`.
4. **Idempotência (após o lock):** `existing = s.transactions.findForIdempotency(cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId)`.
   - Se houver alguma linha: escolher a que tem `idempotency_key = cmd.idempotencyKey` se existir, senão a do par (provider, externalId).
     - `row.idempotencyKey !== cmd.idempotencyKey` (o externalId já está ligado a outra key) → `IDEMPOTENCY_CONFLICT` (`reason: 'EXTERNAL_ID_BOUND_TO_OTHER_KEY'`).
     - Há 2 linhas distintas (key aponta para uma, externalId para outra) → `IDEMPOTENCY_CONFLICT` (`reason: 'KEY_AND_EXTERNAL_ID_MISMATCH'`).
     - `!row.matchesPayload(hash)` → `IDEMPOTENCY_CONFLICT` (`reason: 'PAYLOAD_MISMATCH'`).
     - Senão → **replay**: `toResultFromTransaction(row, idempotentReplay = true)` (status atual, `failureCode`, `result_balance_amount`/`result_wallet_version`). Métrica `duplicates{source, type="replay"}`.
     - Em todos esses casos: (SQS) `s.inbox.markProcessed(msg, row?.id ?? null)`; retornar sem outros efeitos. Conflito → métrica `duplicates{type="conflict"}` + log `warn`.
   - Se não houver linha e `wallet === null` → `{ outcome: 'WALLET_NOT_FOUND' }` (SQS: `markProcessed(msg, null)`); nada mais é persistido (não há wallet para FK; ver §22).
5. **Criar entidade:** `tx = WagerTransaction.create({ id: ids.next(), ...cmd, payloadHash: hash, source: cmd.source.type, createdAt: now })` (PENDING).
6. **Referência:** se `cmd.referenceExternalTransactionId`:
   `reference = s.transactions.findByProviderExternalId(cmd.providerId, ref)`;
   `alreadyReversed = reference && tx.isReversal() ? s.transactions.hasProcessedReversal(reference.id) : false`.
   (Consistente: toda mutação de transações desta wallet ocorre sob o mesmo lock de wallet; se a referência é de outra wallet, a decisão é `REFERENCE_MISMATCH`, independente do seu status.)
7. **Decidir e aplicar** — `WagerEvaluator.apply({ scope: s, tx, wallet, reference, alreadyReversed, now, ctx })`:
   - `decision = WagerPolicy.decide(...)`.
   - `APPLY`: `expectedVersion = wallet.version`; `entry = direction === DEBIT ? wallet.debit(...) : wallet.credit(...)`; `tx.markProcessed({ referenceTransactionId, at: now, balanceAfter: wallet.balance, walletVersion: wallet.version })`; eventos: `WagerTransactionProcessed`, `WalletBalanceChanged`.
   - `RECORD_ONLY` (LOSS): `tx.markProcessed({ ..., balanceAfter: wallet.balance, walletVersion: wallet.version })`; evento `WagerTransactionProcessed`.
   - `REJECT`: `tx.reject({ code, at: now, observedBalance: exposeBalance ? wallet.balance : undefined, walletVersion: exposeBalance ? wallet.version : undefined, referenceTransactionId })`; evento `WagerTransactionRejected`.
   - `AWAIT_REFERENCE`: `tx.markPendingReference({ at: now, nextCheckAt: now + ReferenceRetryPolicy.initialDelay, observedBalance: wallet.balance, walletVersion: wallet.version })`; evento `WagerTransactionPendingReference`.
8. **Persistir a transação:** `inserted = s.transactions.insertIfAbsent(tx)`. `false` → `throw new IdempotencyRaceError()` (rollback; a próxima tentativa cai no passo 4 e vira replay/conflito). Só acontece quando a mesma key chega com `walletId` diferentes simultaneamente (locks em wallets distintas).
9. **Saldo e ledger (apenas APPLY):** `s.wallets.saveBalance(wallet, expectedVersion)`; `s.ledger.append(entry)`.
10. **Nudge (apenas PROCESSED):** `s.transactions.nudgeAwaiting(tx.providerId, tx.externalTransactionId, tx.walletId)` → `UPDATE wager_transactions SET next_reference_check_at = now() WHERE status='PENDING_REFERENCE' AND provider_id=? AND reference_external_transaction_id=? AND wallet_id=? AND next_reference_check_at > now()` (o worker pega na próxima varredura; otimização, não garantia).
11. **Outbox:** `s.outbox.enqueue(events.map(OutboxMessage.enqueue))`.
12. **Inbox (SQS):** `s.inbox.markProcessed(msg, tx.id)`.
13. Retornar `toResultFromTransaction(tx, idempotentReplay = false)` → COMMIT.

Após o commit (fora da transação): métricas (`transactions_total{kind,status,source}`, `processing_duration_seconds`), log `info` com ids. **Nenhuma** publicação de evento acontece aqui — só o outbox publisher publica (§13).

Contexto de eventos (`EventContext`): `correlationId = cmd.correlationId`; `causationId = messageId` (SQS) ou `requestId` (HTTP).

### 8.4 Resultado

```ts
export type ProcessWagerResult =
  | { outcome: 'TRANSACTION'; transactionId: string; status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';
      failureCode: FailureCode | null; balance: MoneyProps | null; walletVersion: number | null; idempotentReplay: boolean }
  | { outcome: 'IDEMPOTENCY_CONFLICT'; reason: 'PAYLOAD_MISMATCH' | 'EXTERNAL_ID_BOUND_TO_OTHER_KEY' | 'KEY_AND_EXTERNAL_ID_MISMATCH'; existingTransactionId: string }
  | { outcome: 'WALLET_NOT_FOUND' }
  | { outcome: 'DUPLICATE_MESSAGE' };
```

O use case **nunca lança** para resultados de negócio; lança apenas `ValidationError` (domínio rejeitou o comando), `TransientInfrastructureError` e erros permanentes/bugs.

### 8.5 Garantias decorrentes

- 50 cópias da mesma aposta em paralelo (qualquer nº de instâncias): todas serializam no lock da wallet; a primeira insere; as demais, ao obter o lock, encontram a linha no passo 4 → replay. Um único débito; `UNIQUE(idempotency_key)` impede o segundo mesmo com bug.
- Duas apostas distintas de 80 com saldo 100: serializadas; a segunda vê saldo 20 → `INSUFFICIENT_FUNDS`.
- Crash antes do commit: nada persistido (inclusive inbox) → redelivery reprocessa. Crash após o commit e antes do ack: redelivery encontra o inbox → `DUPLICATE_MESSAGE` → ack. Se a mesma operação chegar com outro `messageId`, o passo 4 devolve replay.

---

## 9. Outros use cases

### 9.1 `CreateWallet`

Entrada: `{ playerId: uuid, initialBalance: MoneyProps }` (zod; `amount` regex §4.1, aceita `"0.00"`).
Em uma `uow.run`:
1. `walletId = ids.next()`; se `initialBalance > 0`: `openingTxId = ids.next()`, `entryId = ids.next()`.
2. `{ wallet, openingEntry } = Wallet.open({...})`.
3. `s.wallets.insert(wallet)`.
4. Se `openingEntry`: `opening = WagerTransaction.createOpening({ id: openingTxId, walletId, playerId, money, payloadHash: sha256(canonicalJson({ walletId, playerId, money })), at })` com `providerId='internal'`, `externalTransactionId='opening:'+walletId`, `idempotencyKey='internal:opening:'+walletId`, `roundId='opening'`, `gameId='internal'`, `source='INTERNAL'`, já `markProcessed({ at, balanceAfter: initialBalance, walletVersion: 1 })`; `insertIfAbsent(opening)`; `s.ledger.append(openingEntry)`; outbox `WagerTransactionProcessed` + `WalletBalanceChanged`.
5. `UniqueViolationError('wallets_player_currency_uk')` → `WalletAlreadyExistsError` (409).
Resposta 201: `{ id, playerId, balance, version: 1 }` (+ `createdAt`).

### 9.2 Queries

- `GetWallet(id)` → `WalletView` ou `NotFoundError('WALLET_NOT_FOUND')`.
- `GetWalletLedger(walletId, cursor?, limit=50)`: `limit` 1..200; verifica existência da wallet (404); `afterVersion = cursor ? decode(cursor) : 0`; `rows = ledgerReadModel.page(walletId, afterVersion, limit + 1)` com `WHERE wallet_id = ? AND wallet_version > ? ORDER BY wallet_version ASC LIMIT ?` (usa `ledger_wallet_version_uk`); `nextCursor = rows.length > limit ? encode(rows[limit-1].walletVersion) : null`.
- `GetWagerTransaction(id)` / `(providerId, externalId)` → `WagerTransactionView` ou 404 `TRANSACTION_NOT_FOUND`.

### 9.3 `ReconcileWallet`

1. `snapshot = reconciliationReadModel.snapshot(walletId)` executado em `uow`/conexão com `REPEATABLE READ, READ ONLY` (um único snapshot consistente, **sem** lock — não bloqueia escritores):
   ```sql
   SELECT id, currency, balance, version FROM wallets WHERE id = ?;
   SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) AS ledger_sum, COUNT(*) AS entries
     FROM wallet_ledger_entries WHERE wallet_id = ?;
   SELECT wallet_version, balance_after FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY wallet_version DESC LIMIT 1;
   SELECT COUNT(*) AS chain_breaks FROM (
     SELECT balance_before, LAG(balance_after, 1, 0::numeric) OVER (ORDER BY wallet_version) AS prev_after
       FROM wallet_ledger_entries WHERE wallet_id = ?) t WHERE balance_before <> prev_after;
   ```
2. `stored = Money.from(balance)`; `calculated` = `ledger_sum` (via Money; soma é ≥ 0 se consistente — se negativa, construir com helper interno que aceita sinal); `difference = stored.subtract(calculated)`.
3. `consistent = difference.isZero() && chainBreaks === 0 && (entries === 0 ? stored.isZero() : lastEntry.balanceAfter === stored && lastEntry.walletVersion === version)`.
4. Se inconsistente: log `error` (`walletId`, `difference`, `chainBreaks`), `wagering_reconciliation_mismatches_total` +1. **Nunca** corrige.
5. Sempre `wagering_reconciliation_checks_total{result}`.

Resposta 200 (inclusive quando inconsistente):
```json
{ "walletId": "...", "storedBalance": {...}, "calculatedBalance": {...}, "difference": {...},
  "consistent": true, "checkedEntries": 42, "issues": [] }
```
`issues` ⊂ `["BALANCE_DIFFERS_FROM_LEDGER_SUM", "LAST_ENTRY_MISMATCH", "LEDGER_CHAIN_BROKEN"]`.

---

## 10. Worker de PENDING_REFERENCE

### 10.1 Política (`ReferenceRetryPolicy`, domínio, pura)

- `initialDelay = PENDING_REF_BASE_DELAY_MS` (2 s).
- Após a n-ésima falha (`attempts = n`, 1-based): `delay = min(base · 2^n, PENDING_REF_MAX_DELAY_MS)` (máx 300 s).
- Expira quando `attempts >= PENDING_REF_MAX_ATTEMPTS` (10).
- Janela total ≈ 2+4+8+16+32+64+128+256+300+300 ≈ **1110 s (~18,5 min)**.

Justificativa: entregas fora de ordem vêm de corridas entre filas/retries de provedores, normalmente resolvidas em segundos; a janela de ~18 min cobre retries de provedores e indisponibilidades curtas da fila (SQS retém mensagens bem além disso, mas o redrive manda para a DLQ após 5 recebimentos com backoff ≤ 5 min, ou seja, a referência que não chegou em ~18 min provavelmente está na DLQ e exige ação humana). Manter reversões indefinidamente abertas atrasa a conciliação do provedor e permite reversões "zumbis". Valores configuráveis; testes usam base 100 ms, max 3 tentativas.

### 10.2 Claim (transação curta própria)

```sql
WITH due AS (
  SELECT id FROM wager_transactions
   WHERE status = 'PENDING_REFERENCE' AND next_reference_check_at <= now()
   ORDER BY next_reference_check_at
   LIMIT ? FOR UPDATE SKIP LOCKED)
UPDATE wager_transactions t
   SET next_reference_check_at = now() + (? * interval '1 millisecond'), updated_at = now()
  FROM due WHERE t.id = due.id
RETURNING t.id, t.wallet_id;
```
(`?` = batch `PENDING_REF_BATCH_SIZE`=20 e lease `PENDING_REF_LEASE_MS`=30000.) O lease impede que outro worker pegue o mesmo item durante o processamento; se a instância morrer, o item volta a ficar "due" após o lease.

### 10.3 Resolução (uma transação por item)

`ResolvePendingReferences.runOnce(): Promise<number>` → para cada item claimado, `withTransientRetry(() => uow.run(s => …))`:
1. `wallet = s.wallets.findByIdForUpdate(item.walletId)` (mesma ordem de locks: wallet → tx).
2. `tx = s.transactions.findByIdForUpdate(item.id)`; se `tx.status !== PENDING_REFERENCE` → nada (já resolvido por outra instância).
3. `reference`, `alreadyReversed` como no passo 6 de §8.3.
4. `decision = WagerPolicy.decide(...)`:
   - `AWAIT_REFERENCE`: `attempts = tx.referenceAttempts + 1`;
     - `attempts >= max` → `tx.reject({ code: REFERENCE_NOT_FOUND, ... observedBalance })` + evento `WagerTransactionRejected`; métrica `pending_reference_expired_total`.
     - senão → `tx.recordReferenceMiss({ at: now, nextCheckAt: now + delay(attempts) })`; sem evento; métrica `pending_reference_retries_total`.
   - demais decisões: exatamente o mesmo `WagerEvaluator.apply` de §8.3 passo 7, porém persistindo com `s.transactions.update(tx, 'PENDING_REFERENCE')` em vez de `insertIfAbsent`, seguido de saldo/ledger/nudge/outbox.
5. Correlation dos eventos: `correlationId = tx.correlationId ?? tx.id`, `causationId = 'pending-reference-worker'`.

### 10.4 Erros no worker

- `TransientInfrastructureError` após retries → log `warn`, item permanece (lease expira, nova tentativa depois).
- Erro permanente inesperado (ex.: `IntegrityViolationError`, bug) → nova `uow.run` curta: lock wallet → lock tx → se ainda PENDING_REFERENCE, `tx.fail({ code: PROCESSING_ERROR })` + evento `WagerTransactionFailed`; log `error`. Evita loop infinito de poison interno.

---

## 11. API HTTP

### 11.1 Endpoints

| Método e rota | Sucesso | Erros |
|---|---|---|
| `POST /wallets` | 201 wallet | 400, 409 `WALLET_ALREADY_EXISTS`, 503 |
| `GET /wallets/:walletId` | 200 `WalletView` | 400 (uuid inválido), 404 `WALLET_NOT_FOUND` |
| `GET /wallets/:walletId/ledger?cursor&limit` | 200 `{ items, nextCursor }` | 400 `VALIDATION_ERROR`/`INVALID_CURSOR`, 404 |
| `POST /wallets/:walletId/reconciliation` | 200 relatório (sempre, inclusive inconsistente) | 404, 503 |
| `POST /wagering/transactions` (header `Idempotency-Key`) | 201 / 200 / 202 / 422 (ver 11.3) | 400, 409, 422, 503 |
| `GET /wagering/transactions/:transactionId` | 200 `WagerTransactionView` | 400, 404 `TRANSACTION_NOT_FOUND` |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 200 `WagerTransactionView` | 404 |
| `GET /health/live` | 200 `{ status: "ok" }` | — |
| `GET /health/ready` | 200 `{ status:"ok", checks }` | 503 `{ status:"unavailable", checks }` |
| `GET /metrics` | 200 `text/plain; version=0.0.4` | — |

Todos os endpoints aceitam/geram `X-Correlation-Id` e o devolvem no header da resposta.

### 11.2 Corpo de erro (único para todos os endpoints)

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "Idempotency-Key already used with a different payload",
    "retryable": false,
    "details": { "reason": "PAYLOAD_MISMATCH", "existingTransactionId": "..." }
  },
  "correlationId": "0192..."
}
```

Mapeamento (`app-exception.filter.ts`):

| Situação | Status | `code` | `retryable` |
|---|---|---|---|
| zod / domínio inválido | 400 | `VALIDATION_ERROR` (`details: [{ path, message }]`) | false |
| header ausente/ inválido | 400 | `IDEMPOTENCY_KEY_REQUIRED` | false |
| cursor inválido | 400 | `INVALID_CURSOR` | false |
| JWT ausente/inválido (auth ligada) | 401 | `UNAUTHORIZED` | false |
| provider do token ≠ provider da requisição | 403 | `FORBIDDEN` | false |
| recurso inexistente (GET/reconciliação) | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | false |
| conflito de idempotência | 409 | `IDEMPOTENCY_CONFLICT` | false |
| wallet duplicada | 409 | `WALLET_ALREADY_EXISTS` | false |
| rejeição de negócio | 422 | o `failureCode` | false |
| `TransientInfrastructureError` | 503 (+ `Retry-After: 1`) | `TRANSIENT_FAILURE` | **true** |
| qualquer outro | 500 | `INTERNAL_ERROR` (sem stack/mensagem interna) | false |

Rejeições `ZodError`/`InvalidMoneyError`/`InvalidWagerTransactionError` podem surgir no controller (pipe) ou no use case: ambas viram 400.

### 11.3 `POST /wagering/transactions`

Corpo: exatamente o do desafio (+ `referenceExternalTransactionId` opcional). Header `Idempotency-Key` obrigatório (default recomendado ao provedor: `"{providerId}:{externalTransactionId}"`; não é imposto).

Corpo de resposta para resultado `TRANSACTION`:
```json
{ "transactionId": "...", "status": "PROCESSED", "failureCode": null,
  "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

| Resultado | Status HTTP |
|---|---|
| PROCESSED nova | **201** |
| PROCESSED replay | **200** (`idempotentReplay: true`) |
| PENDING_REFERENCE (nova ou replay) | **202** |
| REJECTED (nova ou replay) | **422**; corpo = resultado acima **+** `"error": { "code": failureCode, "message", "retryable": false }` e `correlationId` |
| FAILED (replay) | **500**; corpo = resultado + `error.code = failureCode` |
| `IDEMPOTENCY_CONFLICT` | 409 (corpo de erro) |
| `WALLET_NOT_FOUND` | 422 (corpo de erro, `code: WALLET_NOT_FOUND`, sem transactionId) |

`balance` é `null` para `WALLET_PLAYER_MISMATCH`/`CURRENCY_MISMATCH` (não expor saldo de wallet alheia/moeda errada). Para PENDING_REFERENCE é o saldo observado no aceite; quando a pendência resolve, replays passam a retornar o resultado final.

### 11.4 Cursor do ledger

`cursor = base64url(JSON.stringify({ v: 1, after: walletVersion }))`. Decodificação valida `v === 1` e `after` inteiro ≥ 0; senão `INVALID_CURSOR`. Estável (baseado em `wallet_version`, único e monotônico por wallet; o ledger é append-only) e opaco.

`items[]`: `{ id, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion, createdAt }` em ordem crescente de `walletVersion`.

### 11.5 Health

- `/health/live`: 200 sempre que o processo responde.
- `/health/ready`: `SELECT 1` (timeout 1 s) e `GetQueueAttributes(wager queue, ['QueueArn'])` (timeout 2 s); `readinessState.shuttingDown` → 503 imediato. Corpo: `{ status, checks: { database: { status, latencyMs }, sqs: { status, latencyMs } } }`.
- Ambos `@Public()` (sem auth). `/metrics` também público (em produção ficaria atrás da rede interna — limitação documentada).

---

## 12. Consumer SQS

### 12.1 Filas

| Fila | Atributos |
|---|---|
| `wager-transactions-dlq.fifo` | `FifoQueue=true`, `MessageRetentionPeriod=1209600` |
| `wager-transactions.fifo` | `FifoQueue=true`, `VisibilityTimeout=30`, `ContentBasedDeduplication=false`, `RedrivePolicy={"deadLetterTargetArn": <dlq arn>, "maxReceiveCount": 5}` |
| `wallet-events.fifo` | `FifoQueue=true`, `ContentBasedDeduplication=false` (destino do outbox) |

Criadas por `queue-provisioner.ensureQueues()` (idempotente: `CreateQueue` com os mesmos atributos; DLQ primeiro para obter o ARN). Testes criam filas próprias com prefixo único, `VisibilityTimeout=2`, `maxReceiveCount=3`.

Produtores enviam com `MessageGroupId = walletId` (ordenação por wallet = otimização) e `MessageDeduplicationId = messageId`. A correção **não** depende disso (inbox + idempotência + lock no banco).

### 12.2 Loop

`WagerTransactionsConsumer` (provider Nest; `onApplicationBootstrap` inicia se `SQS_CONSUMER_ENABLED`):

```
while (!stopping):
  resp = ReceiveMessage({ QueueUrl, MaxNumberOfMessages: SQS_BATCH_SIZE(10), WaitTimeSeconds: SQS_WAIT_TIME_S(20),
                          VisibilityTimeout: SQS_VISIBILITY_TIMEOUT_S(30),
                          MessageSystemAttributeNames: ['ApproximateReceiveCount','MessageGroupId'],
                          MessageAttributeNames: ['All'] }, { abortSignal })
  received = resp.Messages ?? []
  agrupar por MessageGroupId; grupos em paralelo; mensagens do mesmo grupo em sequência
  inFlight = Promise.allSettled(grupos.map(processGroup)); await inFlight
erros do Receive (rede/LocalStack fora): log warn, métrica, backoff 1s→30s, continuar
```

`handle(message)`:
1. `body = message.Body`; `messageHash = sha256(body)`.
2. Parse JSON + `sqsEnvelopeSchema` (`messageId` 1..200, `type === 'WagerTransactionRequested'`, `occurredAt` ISO, `data` = schema de §8.1 + `idempotencyKey`). Falha → **poison**.
3. `correlationId = MessageAttributes.correlationId?.StringValue ?? envelope.messageId`.
4. `faultInjector.transientFailure(envelope.messageId)` → lança `TransientInfrastructureError` (testes).
5. `result = processWager.execute({ ...data, source: { type: 'SQS', consumerName: SQS_CONSUMER_NAME, messageId: envelope.messageId, messageHash }, correlationId })`.
6. `faultInjector.afterCommit('sqs-before-ack', envelope.messageId)` → `process.exit(137)` se configurado.
7. Classificar e agir (12.3).

### 12.3 Classificação de erros/resultados (`message-classifier.ts`)

| Caso | Ação | Métrica `wagering_sqs_messages_total{result}` |
|---|---|---|
| `TRANSACTION` (PROCESSED/REJECTED/PENDING_REFERENCE/FAILED, novo ou replay), `IDEMPOTENCY_CONFLICT`, `WALLET_NOT_FOUND`, `DUPLICATE_MESSAGE` | `DeleteMessage` (ack) | `ack` (+ `duplicate` quando aplicável) |
| JSON inválido, schema inválido, `type` desconhecido, `ValidationError` | **poison**: `SendMessage` para a DLQ (mesmo body; `MessageGroupId` original ou `'poison'`; `MessageDeduplicationId = sha256(body)`; atributos `errorCode`, `errorMessage` truncado 256) e então `DeleteMessage` | `dlq` + `wagering_sqs_dlq_messages_total{reason="invalid_payload"}` |
| `TransientInfrastructureError` ou erro desconhecido/permanente (`IntegrityViolationError`, bug) | **não** deletar; `ChangeMessageVisibility(min(SQS_RETRY_BASE_S · 2^(receiveCount-1), SQS_RETRY_MAX_S))` (2 s, 4 s, 8 s, 16 s…, máx 300 s). Após `maxReceiveCount` recebimentos o **redrive** do SQS move para a DLQ | `retry` (`receiveCount >= maxReceiveCount` → log `error` "será movida para DLQ") |

Erros desconhecidos são tratados como "retry até a DLQ" (pode ser transitório não classificado; se for permanente, a DLQ é o destino após 5 tentativas). Delete/ChangeVisibility que falham: log + métrica; a mensagem simplesmente reaparece (seguro pela inbox).

Head-of-line blocking: em FIFO, uma mensagem em backoff segura as demais do mesmo grupo (wallet) — aceito e documentado.

### 12.4 Shutdown gracioso (SIGTERM)

`main.ts` chama `app.enableShutdownHooks(['SIGTERM','SIGINT'])`. Em `beforeApplicationShutdown`:
1. `readinessState.shuttingDown = true` (`/health/ready` → 503).
2. `stopping = true`; `abortController.abort()` cancela o long-poll em curso.
3. Mensagens recebidas mas **não iniciadas** → `ChangeMessageVisibilityBatch(VisibilityTimeout=0)` (voltam imediatamente para outra instância).
4. Aguarda as em andamento (`inFlight`) até `SHUTDOWN_GRACE_MS` (25 s; compose `stop_grace_period: 30s`). Mensagens que terminarem são ackadas normalmente. Se o prazo estourar, as restantes também recebem visibilidade 0 (o use case é idempotente; se commitar depois, a redelivery vira `DUPLICATE_MESSAGE`).
5. Workers (outbox/pending) param o loop e aguardam o tick atual.
6. `onApplicationShutdown`: `orm.close()`, `sqsClient.destroy()`.

No container: `init: true` (tini repassa sinais) e `CMD ["bun", "src/main.ts"]` (sem `bun run` intermediário).

---

## 13. Outbox publisher

### 13.1 Ciclo (`PublishOutboxBatch.runOnce(): Promise<number>`)

1. **Claim** (transação curta):
   ```sql
   WITH due AS (
     SELECT id FROM outbox_messages
      WHERE published_at IS NULL AND next_attempt_at <= now()
      ORDER BY next_attempt_at, occurred_at
      LIMIT ? FOR UPDATE SKIP LOCKED)
   UPDATE outbox_messages o SET next_attempt_at = now() + (? * interval '1 millisecond')
     FROM due WHERE o.id = due.id
   RETURNING o.*;
   ```
   (`OUTBOX_BATCH_SIZE`=50, `OUTBOX_LEASE_MS`=30000.) `SKIP LOCKED` garante que publishers concorrentes peguem lotes disjuntos; o lease tira os itens do "due" enquanto são publicados **fora** da transação (nenhuma transação aberta durante chamada de rede).
2. `faultInjector.afterOutboxClaim()` (testes: `process.exit(137)`).
3. **Publish**: `publisher.publishBatch(messages)` em lotes de 10 (`SendMessageBatch`) para `wallet-events.fifo`: `MessageBody = JSON.stringify(payload)`, `MessageGroupId = partition_key` (walletId), `MessageDeduplicationId = id` (eventId), atributos `eventType`, `eventId`, `correlationId`.
4. **Mark** (transação curta): sucessos → `UPDATE outbox_messages SET published_at = ? WHERE id = ANY(?) AND published_at IS NULL`; observar `outbox_publish_lag_seconds = published_at - occurred_at`.
5. **Retry**: para cada falha, `msg.scheduleRetry(now)` (attempts+1; `nextAttemptAt = now + exponentialBackoffMs(attempts, OUTBOX_RETRY_BASE_MS=1000, OUTBOX_RETRY_MAX_MS=300000)`) e `saveRetry(msg, error.slice(0, 500))`. **Sem limite de tentativas**: evento confirmado nunca é descartado; `attempts` alto aparece em métrica/log `error` a partir de 10.
6. Se `publishBatch` lançar (SQS fora do ar): todas do lote vão para retry (passo 5).

O worker roda em loop: se o lote veio cheio, executa de novo imediatamente; senão espera `OUTBOX_POLL_INTERVAL_MS` (500 ms).

### 13.2 Semântica de entrega

- **At-least-once**. Duplicatas possíveis: (a) crash após publicar e antes de marcar; (b) lease expirado durante publicação lenta. O consumidor deduplica por `eventId` (também `MessageDeduplicationId` no FIFO, janela de 5 min — otimização).
- Cenário do §11 do desafio: commit → processo morre → linhas continuam `published_at IS NULL` → outra instância as reivindica (imediatamente se nunca foram claimadas; após o lease se a instância morta tinha claimado) → publica → duplicata eventual é segura.
- Ordem: por wallet é "melhor esforço" (FIFO por `MessageGroupId`, mas dois publishers podem intercalar lotes). Eventos carregam `walletVersion`/`occurredAt` para o consumidor ordenar. Limitação documentada.

### 13.3 `OutboxMessage` / `InboxMessage`

Como no §6.5 do desafio, com: `OutboxMessage.enqueue(event)` → `id = event.eventId`, `aggregateId = event.aggregateId`, `eventType = event.eventType`, `payload = event.toJSON()` (convertido para objeto JSON puro), `attempts = 0`, `nextAttemptAt = event.occurredAt`. Campos extras: `aggregateType`, `partitionKey`, `eventVersion`, `correlationId`, `causationId`. `isPending() = publishedAt === undefined`; `isDue(now) = isPending() && nextAttemptAt <= now`; `markPublished(at)` lança se já publicado.

### 13.4 Eventos (subclasses de `IntegrationEvent<T>`, `version = 1`)

`IntegrationEvent` conforme §11 do desafio (`eventId` uuid v7, `toJSON()` com `occurredAt` ISO). Cada subclasse tem `static from(...)` e `aggregateType`/`partitionKey`:

| Evento | aggregateId | Quando | `data` |
|---|---|---|---|
| `WagerTransactionProcessed` | transactionId | PROCESSED (inclui LOSS e OPENING) | `{ transactionId, providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money, referenceTransactionId, balanceAfter, walletVersion, processedAt }` |
| `WagerTransactionRejected` | transactionId | REJECTED (inclui expiração `REFERENCE_NOT_FOUND`) | `{ transactionId, providerId, externalTransactionId, walletId, playerId, kind, money, failureCode, referenceExternalTransactionId, rejectedAt }` |
| `WalletBalanceChanged` | walletId | somente com lançamento | conforme §11 do desafio (`walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion`) |
| `WagerTransactionPendingReference` | transactionId | PENDING_REFERENCE no aceite | `{ transactionId, providerId, externalTransactionId, walletId, kind, referenceExternalTransactionId, nextCheckAt }` |
| `WagerTransactionFailed` | transactionId | FAILED (§10.4) | `{ transactionId, providerId, externalTransactionId, walletId, failureCode, failedAt }` |

`partitionKey = walletId` em todos. `data` só contém `MoneyProps`, nunca `Money`.

---

## 14. Observabilidade

### 14.1 Logs (pino JSON)

- Instância raiz em `infrastructure/observability/logger.ts`: `pino({ level: LOG_LEVEL, base: { service: 'wagering', instanceId: INSTANCE_ID }, timestamp: pino.stdTimeFunctions.isoTime, redact: { paths: [...], censor: '[REDACTED]' } })`.
- `nestjs-pino` `LoggerModule.forRoot({ pinoHttp: { logger: rootLogger, genReqId: (req) => req.headers['x-correlation-id'] ?? uuidv7(), customProps: (req) => ({ correlationId: req.id }), serializers: { req: ({ method, url }) => ({ method, url }), res: ({ statusCode }) => ({ statusCode }) }, autoLogging: { ignore: (req) => req.url?.startsWith('/health') || req.url === '/metrics' } } })`; `app.useLogger(app.get(Logger))`, `bufferLogs: true`.
- Redaction paths: `req.headers.authorization`, `req.headers.cookie`, `*.money`, `*.balance`, `*.amount`, `*.balanceBefore`, `*.balanceAfter`, `*.initialBalance`, `body`, `*.body`, `payload`, `*.payload`.
- Contexto obrigatório: consumer/workers usam `logger.child({ correlationId, messageId, transactionId, walletId, providerId })`; o controller de wagering faz o mesmo com o `PinoLogger.assign()`. Nunca logar o payload completo nem valores monetários (exceção: diferença de reconciliação, que é dado de auditoria agregado).
- Níveis: `info` resultado de cada transação (ids + kind + status + failureCode + replay), `warn` conflitos/duplicatas suspeitas/retries, `error` DLQ, reconciliação inconsistente, falhas permanentes.

### 14.2 Métricas (`prom-client`, `GET /metrics`, prefixo `wagering_`)

| Nome | Tipo | Labels | Fonte |
|---|---|---|---|
| `wagering_transactions_total` | counter | `kind, status, source, replay` | use case |
| `wagering_transaction_rejections_total` | counter | `failure_code` | use case/worker |
| `wagering_duplicates_total` | counter | `source (http|sqs), type (replay|conflict|inbox)` | use case |
| `wagering_processing_retries_total` | counter | `operation, reason` | `withTransientRetry` |
| `wagering_lock_conflicts_total` | counter | `reason (lock_timeout|deadlock|serialization)` | `withTransientRetry` |
| `wagering_wallet_lock_wait_seconds` | histogram | — (buckets 0.001…5) | use case |
| `wagering_processing_duration_seconds` | histogram | `source, outcome` | use case |
| `wagering_sqs_messages_total` | counter | `result (ack|duplicate|retry|dlq)` | consumer |
| `wagering_sqs_dlq_messages_total` | counter | `reason` | consumer (envio explícito) |
| `wagering_sqs_queue_messages` | gauge | `queue (main|dlq), state (visible|inflight)` | `collect()` via `GetQueueAttributes` (captura também o redrive automático) |
| `wagering_outbox_pending_messages` | gauge | — | `collect()` (SQL) |
| `wagering_outbox_oldest_pending_age_seconds` | gauge | — | `collect()` (SQL) — **outbox lag** |
| `wagering_outbox_publish_lag_seconds` | histogram | `event_type` | publisher |
| `wagering_outbox_published_total` | counter | `event_type` | publisher |
| `wagering_outbox_publish_failures_total` | counter | — | publisher |
| `wagering_pending_references` | gauge | — | `collect()` (SQL) |
| `wagering_pending_reference_retries_total` | counter | — | worker |
| `wagering_pending_reference_expired_total` | counter | — | worker |
| `wagering_reconciliation_checks_total` | counter | `result (consistent|inconsistent)` | reconcile |
| `wagering_reconciliation_mismatches_total` | counter | — | reconcile |
| `wagering_http_request_duration_seconds` | histogram | `method, route, status_code` | interceptor/middleware |
| default metrics | — | — | `collectDefaultMetrics({ register })` |

Gauges via SQL usam `collect()` assíncrono com timeout de 1 s (falha → mantém valor anterior e loga `warn`). SQL:
`SELECT count(*), COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0) FROM outbox_messages WHERE published_at IS NULL;`
`SELECT count(*) FROM wager_transactions WHERE status = 'PENDING_REFERENCE';`

`MetricsPort` (aplicação) expõe métodos semânticos: `transactionCompleted({kind,status,source,replay,durationMs,outcome})`, `rejection(code)`, `duplicate(source,type)`, `retry(operation,reason)`, `lockWait(seconds)`, `sqsMessage(result)`, `dlq(reason)`, `outboxPublished(eventType, lagSeconds)`, `outboxFailure()`, `pendingReferenceRetry()`, `pendingReferenceExpired()`, `reconciliation(consistent)`.

---

## 15. Autenticação (extra opcional, desligada por padrão)

- **Decisão:** implementar barato, atrás de `ProviderIdentityPort`, com `AUTH_ENABLED=false` por padrão (avaliação e testes rodam sem IdP). Sem tabela de usuários/senhas.
- `ProviderAuthGuard` global (`APP_GUARD`): rotas `@Public()` (health, metrics) passam sempre; se `AUTH_ENABLED=false` → `DisabledProviderIdentity` devolve `anonymous` e tudo passa. Se ligado: `Authorization: Bearer <jwt>` obrigatório (401), verificado por `JwksProviderIdentity` (`jose.jwtVerify(token, createRemoteJWKSet(new URL(AUTH_JWKS_URL)), { issuer: AUTH_ISSUER, audience: AUTH_AUDIENCE || undefined })`); `providerId = payload[AUTH_PROVIDER_CLAIM]` (default `provider_id`), string obrigatória (401 se ausente).
- Autorização por provedor (403 `FORBIDDEN` quando divergir): `POST /wagering/transactions` (`body.providerId`), `GET /providers/:providerId/...` (`params.providerId`); `GET /wagering/transactions/:id` responde 404 se `tx.providerId !== identity.providerId`. Endpoints de wallet exigem apenas token válido (limitação: sem papel de backoffice).
- SQS não passa pelo guard (canal interno confiável, §2 do desafio); o `providerId` da mensagem continua sujeito a todas as validações de domínio.
- Keycloak 26.4 no profile `auth` (§17.1) com realm importado: clients confidenciais `provider-a` (secret `provider-a-secret`) e `provider-b`, `serviceAccountsEnabled: true`, `standardFlowEnabled: false`, mapper `oidc-hardcoded-claim-mapper` com `claim.name=provider_id`, `claim.value=provider-a`, `access.token.claim=true`, `jsonType.label=String`. `KC_HOSTNAME=http://localhost:8080` para que o `iss` seja o mesmo dentro e fora do Docker; `AUTH_ISSUER=http://localhost:8080/realms/wagering`; `AUTH_JWKS_URL=http://keycloak:8080/realms/wagering/protocol/openid-connect/certs` (no container).
- Obter token: `curl -s -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret http://localhost:8080/realms/wagering/protocol/openid-connect/token`.
- Testes do guard usam chaves geradas com `jose.generateKeyPair` e um JWKS local (`createLocalJWKSet`) — sem Keycloak.

---

## 16. Configuração (variáveis de ambiente)

Validadas por zod em `bootstrap/config.ts` (números com `z.coerce.number().int()`, booleanos `"true"|"false"`). Falha de validação → processo encerra com mensagem clara.

| Variável | Default | Uso |
|---|---|---|
| `NODE_ENV` | `development` | — |
| `PORT` | `3000` | HTTP |
| `INSTANCE_ID` | `os.hostname()` | logs/métricas |
| `LOG_LEVEL` | `info` | pino |
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:5432/wagering` | — |
| `DB_POOL_MAX` | `20` | pool |
| `DB_LOCK_TIMEOUT_MS` | `5000` | `lock_timeout` |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | `statement_timeout` |
| `TX_MAX_ATTEMPTS` | `3` | §7.4 |
| `AWS_REGION` | `us-east-1` | — |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | LocalStack |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | — |
| `SQS_WAGER_QUEUE_NAME` | `wager-transactions.fifo` | — |
| `SQS_WAGER_DLQ_NAME` | `wager-transactions-dlq.fifo` | — |
| `SQS_EVENTS_QUEUE_NAME` | `wallet-events.fifo` | outbox |
| `SQS_CONSUMER_NAME` | `wager-transactions-consumer` | inbox |
| `SQS_MAX_RECEIVE_COUNT` | `5` | redrive (provisioner) |
| `SQS_VISIBILITY_TIMEOUT_S` | `30` | — |
| `SQS_WAIT_TIME_S` | `20` | long polling |
| `SQS_BATCH_SIZE` | `10` | — |
| `SQS_RETRY_BASE_S` / `SQS_RETRY_MAX_S` | `2` / `300` | backoff de visibilidade |
| `SQS_CONSUMER_ENABLED` | `true` | — |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | — |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | — |
| `OUTBOX_BATCH_SIZE` | `50` | — |
| `OUTBOX_LEASE_MS` | `30000` | — |
| `OUTBOX_RETRY_BASE_MS` / `OUTBOX_RETRY_MAX_MS` | `1000` / `300000` | — |
| `PENDING_REF_WORKER_ENABLED` | `true` | — |
| `PENDING_REF_POLL_INTERVAL_MS` | `1000` | — |
| `PENDING_REF_BATCH_SIZE` | `20` | — |
| `PENDING_REF_LEASE_MS` | `30000` | — |
| `PENDING_REF_BASE_DELAY_MS` / `PENDING_REF_MAX_DELAY_MS` | `2000` / `300000` | §10.1 |
| `PENDING_REF_MAX_ATTEMPTS` | `10` | §10.1 |
| `SHUTDOWN_GRACE_MS` | `25000` | §12.4 |
| `AUTH_ENABLED` | `false` | §15 |
| `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE`, `AUTH_PROVIDER_CLAIM` | —, —, vazio, `provider_id` | obrigatórios se `AUTH_ENABLED=true` |
| `FAULT_INJECTION_ENABLED` | `false` | habilita os `FAULT_*` (recusado se `NODE_ENV=production`) |
| `FAULT_CRASH_AFTER_COMMIT_MESSAGE_IDS` | vazio | CSV de `messageId`s: `process.exit(137)` após commit e antes do ack |
| `FAULT_CRASH_AFTER_OUTBOX_CLAIM` | `false` | `process.exit(137)` após claim do outbox |
| `FAULT_TRANSIENT_MESSAGE_IDS` | vazio | CSV: consumer lança `TransientInfrastructureError` para esses ids |
| `FAULT_DELAY_IN_TX_MS` | `0` | atraso dentro da transação (shutdown/lock tests) |

---

## 17. Docker

### 17.1 `docker-compose.yml`

```yaml
name: wagering

x-app: &app
  build: .
  image: wagering-app:local
  init: true
  stop_grace_period: 30s
  environment: &app-env
    NODE_ENV: production
    PORT: "3000"
    LOG_LEVEL: info
    DATABASE_URL: postgresql://wagering:wagering@postgres:5432/wagering
    AWS_ENDPOINT_URL: http://localstack:4566
    AWS_REGION: us-east-1
    AWS_ACCESS_KEY_ID: test
    AWS_SECRET_ACCESS_KEY: test
    AUTH_ENABLED: ${AUTH_ENABLED:-false}
    AUTH_ISSUER: http://localhost:8080/realms/wagering
    AUTH_JWKS_URL: http://keycloak:8080/realms/wagering/protocol/openid-connect/certs
  depends_on:
    postgres: { condition: service_healthy }
    localstack: { condition: service_healthy }
    migrate: { condition: service_completed_successfully }
    sqs-init: { condition: service_completed_successfully }
  healthcheck:
    test: ["CMD", "bun", "-e", "const r=await fetch('http://localhost:3000/health/ready');process.exit(r.ok?0:1)"]
    interval: 5s
    timeout: 3s
    retries: 20

services:
  postgres:
    image: postgres:16-alpine
    command: ["postgres", "-c", "max_connections=200"]
    environment: { POSTGRES_USER: wagering, POSTGRES_PASSWORD: wagering, POSTGRES_DB: wagering }
    ports: ["${POSTGRES_HOST_PORT:-5432}:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U wagering -d wagering"]
      interval: 3s
      timeout: 3s
      retries: 30

  localstack:
    image: localstack/localstack:3.8
    environment: { SERVICES: sqs, AWS_DEFAULT_REGION: us-east-1 }
    ports: ["${LOCALSTACK_HOST_PORT:-4566}:4566"]
    healthcheck:
      test: ["CMD", "awslocal", "sqs", "list-queues"]
      interval: 5s
      timeout: 5s
      retries: 30

  migrate:
    <<: *app
    command: ["bun", "src/infrastructure/persistence/migrate-cli.ts", "up"]
    depends_on: { postgres: { condition: service_healthy } }
    healthcheck: { disable: true }
    restart: "no"

  sqs-init:
    <<: *app
    command: ["bun", "scripts/setup-queues.ts"]
    depends_on: { localstack: { condition: service_healthy } }
    healthcheck: { disable: true }
    restart: "no"

  app-1: { <<: *app, ports: ["3001:3000"], environment: { <<: *app-env, INSTANCE_ID: app-1 } }
  app-2: { <<: *app, ports: ["3002:3000"], environment: { <<: *app-env, INSTANCE_ID: app-2 } }
  app-3: { <<: *app, ports: ["3003:3000"], environment: { <<: *app-env, INSTANCE_ID: app-3 } }

  keycloak:
    profiles: ["auth"]
    image: quay.io/keycloak/keycloak:26.4
    command: ["start-dev", "--import-realm"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
      KC_HOSTNAME: http://localhost:8080
    ports: ["8080:8080"]
    volumes: ["./docker/keycloak:/opt/keycloak/data/import:ro"]

volumes:
  pgdata:
```

Notas:
- `localstack/localstack:3.8` verificado (existe; versão 3.x funciona sem auth token; FIFO + redrive validados). Se indisponível no futuro, alternativa: `ministackorg/ministack:latest` (também verificado como existente) — trocar apenas a imagem e o healthcheck.
- Sem scripts shell de init (evita problemas de CRLF/permissão no Windows): filas criadas por `sqs-init` (TypeScript) e migrations por `migrate`.
- `docker/postgres/init/01-create-test-db.sql` roda apenas no primeiro boot do volume; se o volume já existir, `bun run test:reset` cria o banco.

### 17.2 `Dockerfile`

```dockerfile
FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["bun", "src/main.ts"]
```

---

## 18. Plano de testes (`bun test`)

### 18.1 Princípios

- **Unit**: sem I/O; fakes em memória só aqui (`tests/support/fakes.ts`). Clock e IdGenerator determinísticos.
- **Integração/concorrência**: Postgres e LocalStack **reais** do compose (`localhost:5432`, `localhost:4566`), banco separado `wagering_test`, filas com prefixo único por arquivo (`t<timestamp><rand>-wager.fifo`, `-wager-dlq.fifo`, `-events.fifo`; `VisibilityTimeout=2`, `maxReceiveCount=3`) → sem interferência com o ambiente de dev nem entre arquivos.
- Isolamento de dados: cada teste cria **suas próprias wallets** (ids novos) e asserta apenas sobre elas; nenhum `TRUNCATE` (o ledger proíbe). Reset total = `bun run test:reset` (drop/create DB).
- Determinismo: nenhuma espera fixa para asserção; `waitFor(predicate, { timeoutMs, intervalMs: 50 })`. Workers com intervalos curtos em teste (`OUTBOX_POLL_INTERVAL_MS=100`, `PENDING_REF_POLL_INTERVAL_MS=100`, `PENDING_REF_BASE_DELAY_MS=100`, `PENDING_REF_MAX_ATTEMPTS=3`, `OUTBOX_LEASE_MS=2000`, `PENDING_REF_LEASE_MS=2000`, `DB_POOL_MAX=10`).
- **Invariante final em todo teste de integração/concorrência** (`tests/support/invariants.ts` → `assertWalletConsistent(walletId)`), via `Bun.SQL`:
  - `wallets.balance == SUM(CREDIT) - SUM(DEBIT)` do ledger;
  - último `balance_after == wallets.balance` e `wallet_version == wallets.version` (ou sem entries e saldo 0);
  - cadeia sem quebras;
  - `count(ledger) == count(wager_transactions PROCESSED com kind <> 'LOSS')` da wallet;
  - opcional: `POST /wallets/:id/reconciliation` retorna `consistent: true`.
- `support/app-process.ts`: `spawnApp({ port, env })` usa `Bun.spawn(['bun', 'src/main.ts'], { env: { ...testEnv, ...env }, stdout: 'pipe', stderr: 'pipe' })`, espera `/health/ready` 200 (timeout 30 s), expõe `stop()` (SIGTERM/`app` encerra), `kill()` (`proc.kill(9)`; no Windows é término forçado) e `exited`. `startCluster(n, env)` sobe n instâncias em portas `3101..`. Logs dos filhos guardados em buffer e impressos apenas se o teste falhar.
- `support/in-process-app.ts`: `createApp(loadConfig(testEnv, overrides))` + `app.listen(0)`; `app.close()` dispara os mesmos hooks de shutdown que o SIGTERM (usado no teste de shutdown gracioso, multiplataforma).

### 18.2 Unit (`tests/unit/**`)

| Arquivo | Casos |
|---|---|
| `domain/money.test.ts` | aceita `"0.00"`, `"25.00"`, `"999999999999999.99"`; rejeita `""`, `"NaN"`, `"Infinity"`, `"1e3"`, `"-1.00"`, `"1.005"`, `"25"`, `"25.5"`, `"01.00"`, `" 1.00"`, número JS, moeda `"brl"`/`"BR"`; `0.10+0.20 = 0.30` exato; sem arredondamento implícito; imutabilidade; `add/subtract/isLessThan` com moedas diferentes lançam; `equals` com moedas diferentes = false; `negate`/`toJSON` de negativo `"-5.00"`, `-0` → `"0.00"` |
| `domain/wallet.test.ts` | `open` com saldo > 0 cria entry v1; com 0 sem entry; débito/crédito incrementam versão em 1 e geram entry balanceada; débito insuficiente lança; moeda diferente lança; `rehydrate` não valida |
| `domain/wallet-ledger-entry.test.ts` | aritmética validada; moedas misturadas, amount 0, saldo negativo rejeitados; sem setters (tentativa de atribuição falha em type-check — verificado por `// @ts-expect-error`) |
| `domain/wager-transaction.test.ts` | `create` nasce PENDING; validações de referência/amount/kind; todas as transições válidas; transições a partir de terminais lançam `InvalidTransactionStateError`; `recordReferenceMiss` só em PENDING_REFERENCE; `ledgerDirectionFor` p/ cada kind (ROLLBACK de BET→CREDIT, de WIN→DEBIT, de REFUND→DEBIT); `matchesPayload` |
| `domain/wager-policy.test.ts` | BET aplicado / `INSUFFICIENT_FUNDS`; WIN crédito, WIN→BET ok, WIN→WIN `INVALID_REFERENCE_KIND`; LOSS `RECORD_ONLY`; REFUND→BET ok, REFUND→WIN inválido, `AMOUNT_MISMATCH`, `ALREADY_REVERSED`; ROLLBACK de BET/WIN/REFUND; `REVERSAL_INSUFFICIENT_FUNDS`; referência ausente → `AWAIT_REFERENCE`; referência PENDING_REFERENCE → `AWAIT_REFERENCE`; REJECTED → `REFERENCE_NOT_PROCESSED`; `REFERENCE_MISMATCH` (wallet, player, moeda, rodada); `CURRENCY_MISMATCH`; `WALLET_PLAYER_MISMATCH`; ordem de precedência |
| `domain/reference-retry-policy.test.ts` | sequência de delays e expiração |
| `application/payload-hash.test.ts` | vetor de teste de §8.2; ordem das chaves do input irrelevante; ausente ≡ null; qualquer campo de negócio alterado muda o hash; idempotencyKey não entra |
| `application/process-wager.idempotency.test.ts` | com fakes: mesma key + mesmo payload → replay com saldo original; mesma key + payload divergente → `IDEMPOTENCY_CONFLICT`; externalId ligado a outra key → conflito |
| `application/outbox-message.test.ts` | `enqueue` a partir de evento; `scheduleRetry` (1 s, 2 s, 4 s … teto 300 s); `markPublished` duas vezes lança; `isDue` |
| `application/inbox-message.test.ts` | `receive`/`markProcessed` |
| `application/integration-events.test.ts` | `toJSON()` de cada evento: `eventType`, `version`, ISO, `data` com `MoneyProps` |
| `application/ledger-cursor.test.ts` | round-trip; lixo/`v` errado → erro |
| `application/transient-retry.test.ts` | retenta transitório até o limite, não retenta permanente, converte em `TransientInfrastructureError` |
| `infrastructure/pg-error-classifier.test.ts` | cada SQLSTATE da tabela §7.3 |
| `interface/wager-request.schema.test.ts` | regras de §8.1 (amount numérico → erro, OPENING → erro etc.) |
| `interface/message-classifier.test.ts` | tabela §12.3 |
| `interface/provider-auth.guard.test.ts` | público, desligado, token válido, expirado, assinatura inválida, provider divergente |
| `architecture.test.ts` | varre `src/domain/**` e `src/application/**` e falha se algum import casar `^(@nestjs|@mikro-orm|@aws-sdk|pino|prom-client|zod|jose|bun)`; domínio também não pode importar `node:` |

### 18.3 Integração (`tests/integration/**`)

| Arquivo | Verifica |
|---|---|
| `migrations.test.ts` | em um banco descartável `wagering_migr_<rand>`: `up` → todas as tabelas/índices/triggers existem → `down` (todas) → nada resta → `up` de novo OK |
| `constraints.test.ts` | via SQL direto: cada constraint/trigger de §6.8 rejeita o caso inválido (mesma bateria do design: wallet sem ledger, versão +2, saldo negativo, cadeia quebrada, aritmética, UPDATE/DELETE/TRUNCATE no ledger, update de terminal, dupla reversão, moeda do ledger, delete de tx, player+moeda duplicado) e verifica o nome da constraint/mensagem |
| `create-wallet.test.ts` | 201 com OPENING + ledger + 2 eventos outbox; saldo 0 sem ledger; duplicada → 409; payload inválido → 400 |
| `process-wager.atomicity.test.ts` | in-process com um `UnitOfWork` decorado que lança após `ledger.append` (ou com `outbox` falhando): **nada** persiste (tx, saldo, ledger, inbox, outbox); depois, sem falha, tudo persiste junto |
| `idempotency.test.ts` | HTTP replay (200, mesmo saldo original mesmo após outras operações), conflito 409, replay cruzado HTTP→SQS (mesma key) sem novo efeito, PENDING_REFERENCE replay 202 → após resolução replay 200 |
| `http-api.test.ts` | todos os endpoints e status de §11 (400/404/409/422/202/201/200), cursor de ledger estável com 120 lançamentos em páginas de 50, corpo de erro padronizado, `X-Correlation-Id` ecoado |
| `business-rules.test.ts` | ponta a ponta via HTTP: BET/WIN/LOSS/REFUND/ROLLBACK, cada `failureCode`, eventos outbox corretos por desfecho, `WalletBalanceChanged` só quando saldo muda |
| `sqs-consumer.test.ts` | mensagem válida processada e ackada; **redelivery** do mesmo `messageId` (enviado 2× com dedup ids distintos) → 1 efeito, 2º `DUPLICATE_MESSAGE`; payload inválido → DLQ imediata com atributo `errorCode`; `FAULT_TRANSIENT_MESSAGE_IDS` → retries com `ApproximateReceiveCount` crescente e chegada na DLQ após `maxReceiveCount=3` (redrive); rejeição de negócio é ackada (não vai para DLQ) |
| `graceful-shutdown.test.ts` | in-process com `FAULT_DELAY_IN_TX_MS=1500`: enviar 3 mensagens, chamar `app.close()` durante a primeira → a em andamento commita e é ackada; as não iniciadas ficam visíveis imediatamente (outra instância as processa em < visibility timeout) |
| `outbox-publisher.test.ts` | eventos chegam à fila de eventos com envelope correto; SQS indisponível (fila de eventos apontando para nome inexistente via override) → `attempts`/`next_attempt_at` crescem e nada se perde; ao corrigir, publica; **dois publishers in-process concorrentes** sobre 200 mensagens → todas publicadas, conjunto de `eventId` recebido == esperado |
| `pending-reference.test.ts` | ROLLBACK antes do BET → 202 → BET → worker processa o ROLLBACK (saldo restaurado, eventos); REFUND sem BET → após 3 tentativas `REJECTED/REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected` |
| `reconciliation.test.ts` | wallet consistente → `consistent:true`; inconsistência forçada com `SET session_replication_role = replica` (desliga triggers; o usuário do compose é superuser) + `UPDATE wallets SET balance` → `consistent:false`, `difference` correta, métrica `wagering_reconciliation_mismatches_total` incrementada, saldo **não** corrigido |
| `restart-recovery.test.ts` | processo filho com publisher desligado cria transações (outbox pendente) e com PENDING_REFERENCE; `kill()`; novo processo com tudo ligado → outbox drenado, pendências resolvidas; invariantes |

### 18.4 Concorrência (`tests/concurrency/**`) — os 8 cenários obrigatórios

Todos com paralelismo real (`Promise.all` de `fetch`/`SendMessageBatch` contra processos distintos, cada um com seu pool de conexões).

| # | Arquivo | Montagem | Asserções |
|---|---|---|---|
| 1 | `01-same-bet-50x.test.ts` | cluster de 3; wallet 1000.00; mesma requisição BET 10.00 (mesma key) 50× em paralelo, round-robin entre instâncias | todas 201/200; exatamente 1 `idempotentReplay:false`; todas com `transactionId` igual e `balance 990.00`; 1 lançamento DEBIT; saldo 990.00; `wagering_duplicates_total{type="replay"}` somado ≥ 49; invariantes |
| 2 | `02-two-bets-same-wallet.test.ts` | cluster de 3; repetir 20× (20 wallets com 100.00): duas BETs distintas de 80.00 simultâneas em instâncias diferentes | por wallet: 1 PROCESSED (201), 1 REJECTED `INSUFFICIENT_FUNDS` (422); saldo 20.00; 1 DEBIT; reenvio das duas (retry) não muda nada; invariantes |
| 3 | `03-distinct-wallets-parallel.test.ts` | cluster de 3; 20 wallets × 25 operações mistas (BET/WIN/LOSS) em paralelo total | saldo de cada wallet = valor esperado calculado no teste; nº de lançamentos esperado; invariantes em todas |
| 4 | `04-three-instances-mixed.test.ts` | cluster de 3 com HTTP + consumer + publisher + worker ligados; 5 wallets; 300 operações, metade via HTTP, metade via SQS (FIFO com `MessageGroupId = walletId`), incluindo duplicatas propositalmente reenviadas por ambos os canais | fila vazia, DLQ vazia, outbox drenado; nenhum `external_transaction_id` com mais de 1 linha; saldos esperados; invariantes; logs mostram ≥ 2 instâncias processando (via `instanceId` nos logs capturados ou métricas por instância) |
| 5 | `05-crash-after-commit-before-ack.test.ts` | instância A com `FAULT_CRASH_AFTER_COMMIT_MESSAGE_IDS=msg-crash-1`; enviar BET `msg-crash-1`; `await A.exited` (código 137) | DB: tx PROCESSED, inbox com `processed_at`, 1 DEBIT; mensagem continua na fila; subir instância B normal → após visibility (2 s) recebe redelivery (`ApproximateReceiveCount=2`) → `DUPLICATE_MESSAGE` → ack; fila e DLQ vazias; ainda 1 DEBIT; invariantes |
| 6 | `06-two-publishers.test.ts` | (a) 2 processos só com publisher ligado sobre 300 eventos pré-gerados (criados com publisher desligado); (b) publisher A com `FAULT_CRASH_AFTER_OUTBOX_CLAIM=true` morre após claim; B publica após o lease (2 s) | (a) todos `published_at` preenchidos; conjunto de `eventId` recebidos == conjunto esperado; duplicatas contadas e reportadas (esperado 0; asserção: nenhuma perda); (b) os eventos claimados por A são publicados por B; nenhum evento perdido |
| 7 | `07-reversal-before-reference.test.ts` | cluster de 3; ROLLBACK (e, em outra wallet, REFUND) enviados antes da BET referenciada, inclusive simultaneamente com a BET | resposta 202 para a reversão; após BET, worker resolve → PROCESSED; saldo final igual ao inicial; 2 lançamentos (DEBIT+CREDIT); eventos `PendingReference` → `Processed`; segunda reversão da mesma BET → `ALREADY_REVERSED`; invariantes |
| 8 | `08-restart-consistency.test.ts` | cluster de 3; carga de 400 operações (HTTP+SQS) em 10 wallets; no meio, `kill()` em 2 instâncias; reiniciá-las | após estabilizar (fila vazia, inflight 0, outbox pendente 0, nenhum PENDING_REFERENCE "due"): todas as respostas HTTP 2xx/422 têm efeito correspondente; requisições que falharam por conexão encerrada são reenviadas (mesma key) e viram replay ou processamento único; invariantes + reconciliação `consistent:true` para as 10 wallets |

---

## 19. Teste de carga (`bun run test:load`)

`scripts/load-test.ts` (Bun puro, `fetch` + SQS SDK), contra o stack do compose (`app-1..3` em 3001–3003):

- **Parâmetros** (env/flags): `LOAD_DURATION_S=60`, `LOAD_CONCURRENCY=64`, `LOAD_WALLETS=200`, `LOAD_HOT_WALLET_SHARE=0.1`, `LOAD_SQS_MESSAGES=5000`, `LOAD_TARGETS=http://localhost:3001,http://localhost:3002,http://localhost:3003`.
- **Setup**: cria `LOAD_WALLETS` wallets com saldo alto (ex.: `1000000.00`); coleta snapshot inicial de `/metrics` de cada instância.
- **Cenário A — HTTP closed-loop**: `LOAD_CONCURRENCY` workers virtuais, cada um em loop até o fim do tempo: escolhe wallet (10% das requisições na "hot wallet"), monta BET (70%), WIN (20%, ref à BET anterior do mesmo worker), LOSS (5%), REFUND (5%), keys únicas; ~2% de reenvios idênticos (para medir replay). Mede latência com `performance.now()` por requisição; registra status.
- **Cenário B — hot wallet isolada**: 30 s com 100% das requisições numa única wallet (mede custo do lock pessimista).
- **Cenário C — SQS**: envia `LOAD_SQS_MESSAGES` mensagens em `SendMessageBatch` (grupos = wallets) e mede tempo até a fila esvaziar (`ApproximateNumberOfMessages + NotVisible == 0`) → throughput de consumo.
- **Coleta**: throughput (req/s e msg/s), p50/p95/p99/máx (cálculo por ordenação do array de latências), taxa de erro por status (5xx e erros de rede separados de 422 de negócio), deltas de `/metrics` somados das 3 instâncias: `wagering_lock_conflicts_total`, `wagering_processing_retries_total`, `wagering_duplicates_total`, `wagering_wallet_lock_wait_seconds` (p95 aproximado pelos buckets), `wagering_outbox_oldest_pending_age_seconds` amostrado a cada 1 s (máx e p95) e `wagering_outbox_publish_lag_seconds`.
- **Validação pós-carga**: reconciliação de todas as wallets (`consistent:true` obrigatório) — o relatório falha se houver inconsistência.
- **Saída**: escreve `docs/LOAD_TEST.md` com: ambiente (`os.cpus()[0].model`, nº CPUs, RAM, SO, `Bun.version`, versão do Docker, imagens), parâmetros, metodologia, tabelas por cenário, contadores de concorrência, outbox lag, resultado da reconciliação, e uma seção "Análise" com placeholders que o executor preenche honestamente (gargalos observados, ex.: hot wallet serializa por design; host Windows + Docker Desktop distorce números).

---

## 20. Plano de implementação (fases)

Cada fase termina com a verificação indicada **passando** antes de seguir. Registrar o progresso em `docs/NOTES.md`.

**Fase 0 — Scaffolding**
- `git mv README.md docs/CHALLENGE.md`; criar `README.md` provisório (título + "em construção").
- `package.json`, `tsconfig.json`, `biome.json`, `bunfig.toml`, `.gitattributes`, `.gitignore`, `.dockerignore`, `.env.example`, `docker/postgres/init/01-create-test-db.sql`, `docker-compose.yml` (por ora só `postgres` e `localstack`).
- `bun install` (versões exatas de §3.1).
- Verificação: `docker compose up -d postgres localstack` saudáveis; `bun run typecheck`; `bun run lint`.

**Fase 1 — Domínio**
- Todos os arquivos de `src/domain`; `application/shared/canonical-json.ts`, `application/wager/payload-hash.ts`, `application/messaging/*`.
- Unit tests de §18.2 relativos a domínio, hash, eventos, outbox/inbox, e `architecture.test.ts`.
- Verificação: `bun run test:unit`; `bun run typecheck`.

**Fase 2 — Persistência**
- Migrations (SQL de §6.8), `migrate-cli.ts`, `orm.ts`, schemas, mappers, repositórios, `mikro-unit-of-work.ts`, `pg-error-classifier.ts`, `scripts/reset-test-db.ts`.
- Testes: `migrations.test.ts`, `constraints.test.ts`, `pg-error-classifier.test.ts`.
- Verificação: `bun run db:migrate && bun run db:migrate:status && bun run db:migrate:down && bun run db:migrate` (down de uma migration por vez até zero, depois up); `bun run test:reset && bun test tests/integration/migrations.test.ts tests/integration/constraints.test.ts`.

**Fase 3 — Aplicação**
- Portas, erros, `transient-retry`, `WagerEvaluator`, `ProcessWagerTransaction`, `CreateWallet`, queries, `ReconcileWallet`, `ResolvePendingReferences`, `PublishOutboxBatch`.
- Unit tests de aplicação com fakes; teste de integração `process-wager.atomicity.test.ts` (usando UoW real).
- Verificação: `bun run test:unit && bun test tests/integration/process-wager.atomicity.test.ts`.

**Fase 4 — HTTP + Nest + observabilidade**
- `bootstrap/*`, `infrastructure.module.ts`, logger, métricas, health checker, `system/*`, `identity/disabled-provider-identity.ts`, `interface/shared/*`, `interface/http/*` (guard já presente, no-op).
- Testes: `create-wallet`, `http-api`, `idempotency` (parte HTTP), `business-rules`, `reconciliation`.
- Verificação: `bun run start` + `curl -s localhost:3000/health/ready`, `curl -s -XPOST localhost:3000/wallets -H 'content-type: application/json' -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'`, `curl -s localhost:3000/metrics | grep wagering_`; `bun run test:integration`.

**Fase 5 — SQS consumer**
- `sqs-client`, `queue-registry`, `queue-provisioner`, `scripts/setup-queues.ts`, `scripts/send-sample-message.ts`, consumer, classifier, `env-fault-injector`.
- Testes: `sqs-consumer.test.ts`, `graceful-shutdown.test.ts`, `idempotency` (cruzado HTTP↔SQS).
- Verificação: `bun run sqs:setup && bun scripts/send-sample-message.ts` com app rodando → transação visível em `GET /providers/.../wagering/transactions/...`; `bun run test:integration`.

**Fase 6 — Outbox publisher e PENDING_REFERENCE worker**
- `sqs-message-publisher`, `polling-worker`, `outbox-publisher.worker`, `pending-reference.worker`, `db-gauges.collector`.
- Testes: `outbox-publisher.test.ts`, `pending-reference.test.ts`, `restart-recovery.test.ts`.
- Verificação: `bun run test:integration`; com app rodando, `wagering_outbox_pending_messages` volta a 0.

**Fase 7 — Concorrência**
- `tests/support/app-process.ts` e os 8 arquivos de §18.4.
- Verificação: `bun run test:concurrency` 3 vezes seguidas sem falhas (determinismo).

**Fase 8 — Docker completo**
- `Dockerfile`; compose completo (`migrate`, `sqs-init`, `app-1..3`).
- Verificação: `docker compose up -d --build`; `docker compose ps` (3 apps healthy, one-shots `exited (0)`); requisições em 3001/3002/3003; `docker compose stop app-2` (logs mostram shutdown gracioso); `docker compose up -d app-2`.

**Fase 9 — Auth (opcional)**
- `jwks-provider-identity.ts`, guard completo, decorators, `docker/keycloak/wagering-realm.json`, profile `auth`.
- Testes: `provider-auth.guard.test.ts`.
- Verificação: `bun run test:unit`; manual: `AUTH_ENABLED=true docker compose --profile auth up -d`, obter token (§15), `POST /wagering/transactions` sem token → 401, com token de `provider-a` e `providerId: provider-b` → 403, correto → 201.

**Fase 10 — Teste de carga**
- `scripts/load-test.ts`; executar contra o compose; revisar/completar `docs/LOAD_TEST.md`.
- Verificação: `docker compose up -d --build && bun run test:load` gera o relatório com reconciliação 100% consistente.

**Fase 11 — Documentação**
- `README.md` (pré-requisitos, `docker compose up`, comandos `bun run …`, como rodar cada suíte, exemplos `curl` e de mensagem SQS, variáveis principais, como ligar auth).
- `docs/ARCHITECTURE.md` (a partir das seções 0, 1, 4–15, 21, 22 deste documento: decisões em formato ADR curto, justificativas de ORM/`Money`/transação, trade-offs, limitações).
- Verificação final: `bun run lint && bun run typecheck && bun run test` limpos com o compose de pé.

---

## 21. Trade-offs e limitações conhecidas (insumo para `ARCHITECTURE.md`)

1. **Lock pessimista serializa a hot wallet**: throughput por wallet é limitado pela latência de uma transação (~ms). Escala horizontal ajuda wallets distintas, não uma única wallet quente. Alternativa (não adotada): sharding de saldo/sub-wallets.
2. **Lock da wallet mesmo para replays/rejeições/LOSS**: simplifica o raciocínio (toda decisão sob o mesmo lock) ao custo de alguma espera extra em replays.
3. **Triggers de integridade** adicionam custo por escrita (consulta indexada no ledger por INSERT e verificação diferida no COMMIT) e lógica no banco; compensam por tornar as invariantes de §5.9 verificáveis no schema.
4. **`WALLET_NOT_FOUND` não é persistido** (sem FK alvo): não há trilha de auditoria nem evento para essa rejeição; fica em log e métrica.
5. **Reversão única "estrita"**: uma BET revertida por REFUND não pode também receber ROLLBACK (e vice-versa). Interpretação mais conservadora da regra 4 (evita duplo crédito).
6. **Ordem de eventos por wallet é "melhor esforço"** com múltiplos publishers; consumidores devem usar `walletVersion`/`eventId`.
7. **Head-of-line blocking** em SQS FIFO durante backoff de uma mensagem da mesma wallet.
8. **Relógios**: leases e "due" usam `now()` do banco; `next_attempt_at`/`next_reference_check_at` calculados no app usam o relógio da instância (pressupõe NTP; skew de segundos é inócuo).
9. **Outbox sem limite de tentativas**: nunca descarta evento confirmado; um destino permanentemente quebrado acumula linhas (visível em `outbox_oldest_pending_age_seconds`). Sem limpeza/arquivamento de outbox/inbox publicados (job de retenção ficaria como próximo passo).
10. **Reconciliação sob demanda** apenas (sem job periódico); não corrige nada por design.
11. **Auth**: opcional e desligada por padrão; sem papéis para endpoints de wallet; `/metrics` público.
12. **Moeda única na prática** (BRL nos testes de carga), mas modelo multi-moeda com conflitos testados; sem conversão.
13. **Sem double-entry** (diferencial opcional não implementado); o ledger é single-entry por wallet, encadeado por versão.
14. **Windows host**: testes de concorrência usam término forçado de processo como "crash" (equivalente a SIGKILL); SIGTERM real é demonstrado via `docker compose stop` e testado via `app.close()`.

## 22. Interpretações de regras adotadas

- Idempotência é avaliada por `idempotency_key` **e** por `(providerId, externalTransactionId)`; o mesmo externalId com outra key é conflito (409), não nova transação.
- WIN e LOSS **podem** referenciar uma BET (opcional); se referenciarem, a referência é validada (mesma rodada/wallet/moeda/player, tipo BET) e, se ausente, a transação fica `PENDING_REFERENCE`. Múltiplos WINs para a mesma BET são permitidos. WIN após a BET ter sido revertida é permitido (o provedor é a fonte da verdade da rodada).
- `REFUND`/`ROLLBACK` exigem valor idêntico ao da referência; reversão parcial fora de escopo.
- `ROLLBACK` de `LOSS`, de `ROLLBACK` ou de `OPENING` → `INVALID_REFERENCE_KIND`.
- `amount` deve ser > 0 para BET/WIN/REFUND/ROLLBACK (WIN zero deve ser enviado como LOSS); LOSS aceita ≥ 0 e não move saldo.
- Resultado de replay = estado **atual** da transação (se estava PENDING_REFERENCE e foi resolvida, o replay devolve o resultado final), com o saldo observado no momento em que aquele estado foi atingido.
- `version` da wallet: 1 na criação (inclusive com OPENING, que gera o lançamento de versão 1); +1 a cada lançamento.
- `FAILED` só é produzido pelo worker de PENDING_REFERENCE em erro permanente inesperado (§10.4); erros transitórios nunca viram FAILED (ficam em retry/DLQ).
