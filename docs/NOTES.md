# Diário de trabalho

Registro cronológico do que foi feito durante o desafio (arquitetura → execução → revisão).

## 2026-10-29
- Ambiente: Windows 11, Docker 29.8 / Compose v5.5, Bun 1.4.4 instalado (`~/.bun/bin`).
- Repositório git inicializado.
- Fluxo adotado: agente **Arquiteto** (desenho + plano em `docs/DESIGN.md`) → agente **Executor** (implementação) → agente **Revisor** (conformidade com o README do desafio).
- **Arquiteto**: produzido `docs/DESIGN.md` (design implementation-ready, em PT-BR). Destaques:
  - Stack verificada por smoke test real sob Bun 1.4.4: NestJS 12.3.2, MikroORM 7.2.5 (EntitySchema + migrations SQL manuais), decimal.js, @aws-sdk/client-sqs, nestjs-pino/pino, prom-client, zod 4, jose; TypeScript 5.9.3 (não usar TS 7). LocalStack 3.8 (FIFO + redrive validados), postgres:16-alpine, oven/bun:1.4.4, keycloak 26.4.
  - Schema completo (3 migrations up/down) validado em Postgres 16: CHECKs, UNIQUEs, FKs compostas de moeda/wallet, reversão única (índice parcial), ledger append-only + encadeado por `wallet_version`, constraint trigger diferido saldo⇔ledger, guarda de estados terminais.
  - Concorrência: lock pessimista por wallet (`FOR UPDATE`, READ COMMITTED, lock_timeout), idempotência re-checada após o lock + `ON CONFLICT DO NOTHING`, retry limitado por SQLSTATE.
  - Algoritmo único HTTP/SQS, hash canônico com vetor de teste, taxonomia de failureCodes, mapeamento HTTP, consumer SQS (inbox, ack pós-commit, backoff, DLQ, SIGTERM), outbox com SKIP LOCKED + lease, worker PENDING_REFERENCE (10 tentativas, ~18,5 min), métricas, auth opcional, plano de testes (8 cenários com ≥3 processos e fault injection) e 12 fases de implementação.

### Executor — Fase 0 (scaffolding)
- `git mv README.md docs/CHALLENGE.md`; README provisório; `package.json` (versões exatas de §3.1), `tsconfig.json`, `biome.json`, `bunfig.toml`, `.gitattributes`, `.dockerignore`, `.env.example`, init SQL do banco de teste, compose parcial (postgres + localstack).
- Desvios: `biome.json` liga `unsafeParameterDecoratorsEnabled` (decorators de parâmetro do Nest) e desliga `style/useImportType` (import type apagaria classes usadas como token/metadata do Nest) e `complexity/noStaticOnlyClass` (`WagerPolicy` é estático por design). Imagem `oven/bun:1` local já é 1.4.4.
- Verificação: compose `postgres`/`localstack` healthy; `bun run typecheck` e `bun run lint` limpos.

### Executor — Fase 1 (domínio)
- `src/domain/**` completo (Money, Wallet, WalletLedgerEntry, WagerTransaction + máquina de estados, WagerPolicy, ReferenceRetryPolicy, FailureCode) e `application/messaging/*`, `canonical-json`, `payload-hash`.
- `WalletLedgerEntry` faz `Object.freeze(this)`: imutabilidade estrutural também em runtime (atribuição lança `TypeError`).
- Adições pequenas ao design: `Money.fromSigned` (reidratar somas negativas internas, ex. reconciliação); `reject({ countAttempt })` para contar a última tentativa na expiração de PENDING_REFERENCE; `OutboxMessage.scheduleRetry(now, error?, backoff?)` guarda `lastError`. Em `REFERENCE_MISMATCH` não ligamos `referenceTransactionId` a transações de outra wallet.
- Vetor do hash (§8.2) confere: `6ff120b6…8974`.
- Verificação: `bun run test:unit` → 124 pass; typecheck/lint limpos.

### Executor — Fase 2 (persistência)
- 3 migrations SQL (exatamente o SQL de §6.8), `migrate-cli` (`up`, `down [--to name|--all]`, `status`), `orm.ts`, EntitySchemas (records planos), mappers (um arquivo `mappers.ts` em vez de 5), 5 repositórios, `MikroUnitOfWork`, `pg-error-classifier`, `scripts/reset-test-db.ts`, `config.ts` (antecipado da Fase 4 porque ORM/CLI precisam).
- Desvios: portas de Clock/IdGenerator/MessagePublisher/Logger/ProviderIdentity/FaultInjector agrupadas em `application/ports/system.ts` (arquivos minúsculos); `InboxRepository.tryReceive` devolve também o hash existente (para logar messageId reutilizado com corpo diferente). `findByIdForUpdate` usa `disableIdentityMap` + `refresh` (cada leitura vem do banco; nunca do identity map). `insertIfAbsent` e claims usam SQL nativo com `?`; `markPublished` usa `nativeUpdate` com `$in` (evita expansão de array em placeholder).
- Erros do cliente `Bun.SQL` expõem o SQLSTATE em `errno` (não `code`) — usado nos testes.
- Verificação: ciclo `db:migrate` → `status` → `down` ×3 → `up` → `down --all` → `up` OK; `migrations.test.ts` + `constraints.test.ts` + classifier → 46 pass.

### Executor — Fase 3 (aplicação)
- `transient-retry`, `WagerEvaluator` (compartilhado entre submissão e worker; modo `insert`/`resolve`), `ProcessWagerTransactionUseCase`, `ResolvePendingReferencesUseCase`, `CreateWalletUseCase`, queries, `LedgerCursor`, `ReconcileWalletUseCase`, `PublishOutboxBatchUseCase`; `SystemClock`/`UuidV7IdGenerator` antecipados.
- Use case valida o comando (domínio) **antes** de abrir a transação: comando inválido nunca toca o inbox (SQS → poison/DLQ).
- `wallet_version` do worker na expiração: `reject({countAttempt:true})` registra a última tentativa.
- Fakes em memória (`tests/support/fakes.ts`) com rollback por snapshot — só em unit tests.
- Verificado que `findOne(..., { lockMode: PESSIMISTIC_WRITE })` emite `select … for update`.
- Verificação: unit 171 pass; `process-wager.atomicity.test.ts` (falha injetada após ledger / no outbox → nada persiste; sem falha → tudo junto) 2 pass.

### Executor — Fase 4 (HTTP + Nest + observabilidade)
- `bootstrap/*` (AppModule, createApp, tokens, readiness), `InfrastructureModule` (todos os adapters e use cases via `useFactory`, `@Inject` explícito em tudo), pino + nestjs-pino (JSON, redaction de campos monetários/payload), prom-client (`/metrics`, gauges com `collect()` assíncrono e timeout), health (DB `SELECT 1` + `GetQueueAttributes`), read models SQL (valores `numeric` castados para `text` no SQL), guard global + `@Public()`, filtro de exceções único, controllers.
- Para o `AppModule` compilar, consumer SQS, workers, `sqs-client`, `queue-registry`, `queue-provisioner`, `sqs-message-publisher` e `setup-queues`/`send-sample-message` foram escritos já nesta fase (testes deles nas Fases 5/6).
- Desvios: adicionado `@types/express@5.0.3` (dev) — tipos de `Request/Response`; `http-metrics.middleware.ts` (histograma HTTP por rota-template) e `observability/queue-depth.ts` (gauge de profundidade das filas). Rota inexistente → 404 `ROUTE_NOT_FOUND` no corpo padrão; JSON malformado → 400 `VALIDATION_ERROR`.
- No Windows, `curl localhost` às vezes não resolve para o listener do Bun — usar `127.0.0.1`.
- Verificação manual: `bun run start` → `/health/ready` 200, `POST /wallets` 201, BET 201/replay 200, `/metrics` com `wagering_*`, mensagem SQS de exemplo processada. Testes: `create-wallet`, `http-api`, `business-rules`, `idempotency` (inclui cruzado HTTP↔SQS e replay de PENDING_REFERENCE), `reconciliation` → 36 pass.

### Executor — Fase 5 (consumer SQS)
- Testes: `sqs-consumer.test.ts` (processamento + inbox, redelivery do mesmo messageId com dedup ids diferentes → 1 efeito, mesmo negócio com outro messageId → replay, poison → DLQ imediata com `errorCode`, rejeição de negócio/wallet inexistente → ack, falha transitória injetada → retries com `ApproximateReceiveCount` crescente e redrive para DLQ após 3), `graceful-shutdown.test.ts` (`app.close()` durante a 1ª mensagem: ela commita e é ackada; as 2 não iniciadas voltam visíveis em < 3 s com visibility timeout de 20 s; outra instância processa), unit de `message-classifier` e schemas.
- Desvio: `bunfig.toml` removido — Bun 1.4.4 ignorou `[test] timeout` (testes caíam em 5 s); timeouts agora via `--timeout` nos scripts e por teste.
- Verificação: 7 pass (integração) + 34 pass (unit interface).

### Executor — Fase 6 (outbox publisher + worker PENDING_REFERENCE)
- Testes: `outbox-publisher.test.ts` (envelope/atributos/dedup id = eventId; fila de eventos inexistente → `attempts` e `next_attempt_at` crescem, nada se perde, depois publica; **dois publishers** concorrentes sobre 200 eventos → 200 entregues, 0 perdidos, 0 duplicados), `pending-reference.test.ts` (ROLLBACK antes do BET → 202 → resolvido; REFUND sem BET → `REFERENCE_NOT_FOUND` após 3 tentativas + evento; cadeia BET←WIN←ROLLBACK fora de ordem converge), `restart-recovery.test.ts` (processo filho com publisher/worker desligados é morto; novo processo drena outbox e resolve pendências), unit do caminho FAILED do worker.
- Problema encontrado: leitura de fila FIFO sem deletar bloqueia o grupo (mensagens seguintes do mesmo MessageGroupId ficam invisíveis) — `receiveAll(..., { consume: true })` nos testes.
- `tests/support/app-process.ts` (spawn de `bun src/main.ts`, porta livre, logs em buffer, `kill()`) criado aqui.
- Verificação: `bun run test:reset && bun run test:integration` → 74 pass / 0 fail.

### Executor — Fase 7 (concorrência)
- `tests/support/cluster.ts` (`useCluster(label, n)` sobe N processos reais `bun src/main.ts` com pools próprios; `withFailover`), `money-math.ts` (valores esperados em centavos `BigInt` + PRNG determinístico `mulberry32`).
- 8 cenários em `tests/concurrency/` (11 testes): (1) mesma aposta 50× em 3 instâncias → 1 débito, ≥49 replays na métrica; (2) 20 wallets × duas BETs de 80 em instâncias diferentes → 201+422 por wallet, saldo 20.00, retries viram replay; (3) 20 wallets × 25 operações em paralelo; (4) 3 instâncias completas, 300 ops metade HTTP/metade SQS + 90 duplicatas cruzadas, filas/DLQ/outbox vazios, ≥2 instâncias consumiram; (5) `process.exit(137)` após commit e antes do ack → redelivery vira `DUPLICATE_MESSAGE` em outra instância; (6a) 2 processos publishers sobre 300 eventos → 300 entregues, 0 perdidos/duplicados; (6b) publisher morto após claim → outro publica após o lease; (7) ROLLBACK/REFUND antes da BET (202 → PROCESSED) e corrida reversão×BET em 20 wallets; (8) 400 ops com 2 de 3 instâncias mortas no meio e reiniciadas, 66 requisições refeitas com a mesma key → tudo exatamente uma vez + reconciliação `consistent`.
- Todos os testes terminam com `assertWalletConsistent` (saldo == soma do ledger, último lançamento, cadeia, nº de lançamentos == nº de transações que movem saldo).
- Windows: `proc.kill('SIGKILL')` = TerminateProcess (equivale a crash); `process.exit(137)` preserva o código 137. SIGTERM real é demonstrado no container (Fase 8) e testado via `app.close()`.
- Verificação: `bun run test:concurrency` 3× seguidas → 11 pass / 0 fail em cada (≈56 s).

### Executor — Fase 8 (Docker)
- `Dockerfile` (`oven/bun:1.4.4`, `bun install --frozen-lockfile --production`, roda TS direto, `USER bun`, `STOPSIGNAL SIGTERM`, CMD em exec form) e compose completo (`migrate` e `sqs-init` one-shot, `app-1..3` em 3001–3003 com `init: true`, `stop_grace_period: 30s`, healthcheck em `/health/ready`, `keycloak` no profile `auth`).
- Verificação: `docker compose up -d --build` → migrate/sqs-init `Exited (0)`, 3 apps `healthy`; wallet criada em 3001 e BETs aceitas em 3001/3002/3003 sobre a mesma wallet (saldo 70.00, version 4); `docker compose stop app-2` → log `sqs consumer stopped` e saída em ~1 s com código 143 (Nest executa os hooks e re-emite o SIGTERM); `docker compose up -d app-2` volta `healthy`.

### Executor — Fase 9 (autenticação, opcional)
- `JwksProviderIdentity` (jose `jwtVerify` + JWKS remoto: assinatura, `exp`, `iss`, `aud` opcional, claim `provider_id`), guard global com `@Public()` (health/metrics), `assertProviderAccess` (403 em POST e `/providers/:providerId/...`; `GET /wagering/transactions/:id` responde 404 para outro provider), realm Keycloak `docker/keycloak/wagering-realm.json` (clients `provider-a`/`provider-b`, client credentials, mapper de claim fixo `provider_id` + mapper de audience `wagering-api`).
- Desvio: adicionado `AUTH_AUDIENCE=wagering-api` no compose (o design deixava vazio) — o token do Keycloak passa a ser verificado também por audiência.
- Testes: unit `provider-auth.guard.test.ts` (12: público, desligado, válido, expirado, assinatura errada, issuer/audience errados, sem claim, lixo, 403) e integração `auth.test.ts` (stack HTTP real com JWKS local).
- **Verificação manual com Keycloak real** (`AUTH_ENABLED=true docker compose --profile auth up -d`): token `client_credentials` de `provider-a` (`iss=http://localhost:8080/realms/wagering`, `aud` inclui `wagering-api`) → `/health/ready` sem token 200; `POST /wallets` sem token 401; com token 201; BET como `provider-b` 403 `FORBIDDEN`; BET como `provider-a` 201; token adulterado 401. Depois o stack voltou a `AUTH_ENABLED=false`.
