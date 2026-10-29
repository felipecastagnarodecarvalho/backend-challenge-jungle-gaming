# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) vindas de vários provedores de jogos, por **HTTP** e por **SQS FIFO**. Ele se mantém correto com mensagens duplicadas, fora de ordem e processadas ao mesmo tempo por **várias instâncias**.

- **Stack:** Bun 1.4.4 · TypeScript estrito · NestJS 12 · MikroORM 7 (PostgreSQL 16) · AWS SQS via LocalStack 3.8 · Docker Compose.
- **Garantias:** dinheiro exato (`decimal.js` + `NUMERIC(20,2)`, nunca `number`); ledger imutável e encadeado; saldo materializado sempre igual ao ledger, verificado **no schema** por constraints e triggers; idempotência persistente; inbox/outbox transacionais; lock pessimista **por wallet** (sem lock global).
- **Documentos:**
  - [`ARCHITECTURE.md`](ARCHITECTURE.md): decisões, justificativas, trade-offs e limitações.
  - [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md): teste de carga (ambiente, metodologia, números e análise).
  - [`docs/DESIGN.md`](docs/DESIGN.md): design detalhado que guiou a implementação.
  - [`docs/CHALLENGE.md`](docs/CHALLENGE.md): enunciado original.
  - [`docs/NOTES.md`](docs/NOTES.md): diário de execução, fase a fase, com os desvios do design.
  - [`docs/GLOSARY.md`](docs/GLOSARY.md): glossário de termos, siglas e códigos usados no projeto.

---

## Pré-requisitos

| Ferramenta | Versão usada |
|---|---|
| Docker + Docker Compose | Docker 29.8 / Compose v5 (Docker Desktop no Windows também funciona) |
| Bun | 1.4.4 (`curl -fsSL https://bun.sh/install \| bash` ou `powershell -c "irm bun.sh/install.ps1 \| iex"`) |

As portas `5432` (Postgres), `4566` (LocalStack), `3001–3003` (apps) e `8080` (Keycloak, opcional) precisam estar livres. Para o Postgres e o LocalStack dá para trocar com `POSTGRES_HOST_PORT` e `LOCALSTACK_HOST_PORT`.

> **Windows:** use `127.0.0.1` em vez de `localhost` no `curl`. No Windows, `localhost` pode resolver para `::1` e não alcançar o listener.

---

## Subindo tudo (3 instâncias)

```bash
bun install
docker compose up -d --build      # postgres, localstack, migrate (one-shot), sqs-init (one-shot), app-1..3
docker compose ps                 # app-1..3 "healthy"; migrate e sqs-init "Exited (0)"
curl -s http://127.0.0.1:3001/health/ready
```

Os serviços one-shot aplicam as migrations (`migrate`) e criam as filas FIFO (`sqs-init`: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` com redrive `maxReceiveCount=5`, `wallet-events.fifo`). As instâncias respondem em `http://127.0.0.1:3001`, `:3002` e `:3003`. Cada uma roda HTTP + consumer SQS + publisher do outbox + worker de referências pendentes.

Graceful shutdown: `docker compose stop app-2` envia SIGTERM. A instância reporta `/health/ready` 503, para de consumir, devolve à fila as mensagens não iniciadas, termina as que estão em andamento e fecha as conexões.

### Rodando a aplicação localmente (fora do Docker)

```bash
docker compose up -d postgres localstack
bun run db:migrate                # aplica as migrations no banco "wagering"
bun run sqs:setup                 # cria as filas
bun run start                     # http://127.0.0.1:3000  (bun run dev = watch mode)
```

---

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` / `bun run dev` | sobe a aplicação (porta `PORT`, padrão 3000) |
| `bun run db:migrate` | aplica as migrations pendentes |
| `bun run db:migrate:down` | reverte a última migration (`-- --all` reverte todas; `-- --to <nome>` reverte até a migration indicada) |
| `bun run db:migrate:status` | lista as migrations executadas e as pendentes |
| `bun run sqs:setup` | cria as filas (idempotente) |
| `bun scripts/send-sample-message.ts <walletId> <playerId> [kind] [amount] [externalId]` | publica uma mensagem `WagerTransactionRequested` de exemplo |
| `bun run typecheck` | `tsc --noEmit` (strict) |
| `bun run lint` / `bun run format` | Biome |
| `bun run test:unit` | testes de unidade (sem infraestrutura) |
| `bun run test:reset` | recria o banco `wagering_test` e aplica as migrations |
| `bun run test:integration` | integração contra Postgres e LocalStack **reais** |
| `bun run test:concurrency` | os 8 cenários de concorrência, com **processos reais** (≥3 instâncias) |
| `bun run test` | unit → reset → integração → concorrência |
| `bun run test:load` | teste de carga contra o compose (gera `docs/LOAD_TEST.md`) |

### Testes

Integração e concorrência usam o Postgres e o LocalStack do compose (`docker compose up -d postgres localstack`), com um banco separado (`wagering_test`) e filas próprias, de nome único por arquivo de teste. Nenhum mock substitui Postgres ou SQS nessas suítes.

```bash
docker compose up -d postgres localstack
bun run test:unit           # 243 testes
bun run test:reset
bun run test:integration    # 90 testes (16 arquivos)
bun run test:concurrency    # 11 testes (8 cenários; sobe processos `bun src/main.ts`)
```

Todo teste de integração e de concorrência termina com a invariante `wallet.balance == saldo reconstruído pelo ledger`, mais último lançamento, cadeia de versões e contagem de lançamentos (`tests/support/invariants.ts`).

### Teste de carga

```bash
docker compose up -d --build
bun run test:load
# parâmetros: LOAD_DURATION_S=60 LOAD_HOT_DURATION_S=30 LOAD_CONCURRENCY=64 LOAD_WALLETS=200
#             LOAD_HOT_WALLET_SHARE=0.1 LOAD_SQS_MESSAGES=5000 LOAD_TARGETS=http://127.0.0.1:3001,...
```

Resultado, metodologia e análise em [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md).

### Autenticação (opcional, profile `auth`)

Desligada por padrão (`AUTH_ENABLED=false`). Para ligar com o Keycloak (realm `wagering` importado de `docker/keycloak/`):

```bash
AUTH_ENABLED=true docker compose --profile auth up -d
# aguarde o Keycloak (~30 s): curl -s http://127.0.0.1:8080/realms/wagering/.well-known/openid-configuration
TOKEN=$(curl -s -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret \
  http://127.0.0.1:8080/realms/wagering/protocol/openid-connect/token | sed 's/.*"access_token":"\([^"]*\)".*/\1/')
curl -s http://127.0.0.1:3001/wallets/<id> -H "Authorization: Bearer $TOKEN"
```

- Clients: `provider-a`/`provider-a-secret` e `provider-b`/`provider-b-secret` (client credentials). O token traz a claim `provider_id` e a audiência `wagering-api`.
- Sem token ou com token inválido → `401 UNAUTHORIZED`. Token de `provider-a` agindo como `provider-b` → `403 FORBIDDEN`. `/health/*` e `/metrics` são sempre públicos. Mensagens SQS são canal interno (não passam pelo guard).
- Para voltar ao padrão: `docker compose --profile auth stop keycloak && docker compose up -d`.

---

## API — exemplos

Todas as respostas trazem `X-Correlation-Id`, que é ecoado se você enviar um. Os erros seguem um corpo único:

```json
{ "error": { "code": "IDEMPOTENCY_CONFLICT", "message": "...", "retryable": false, "details": { } }, "correlationId": "..." }
```

```bash
B=http://127.0.0.1:3001
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1

# Criar wallet (saldo inicial > 0 gera transação OPENING + lançamento CREDIT na mesma transação SQL)
curl -s -X POST $B/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
# 201 {"id":"<WALLET>","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1,...}
# repetir → 409 WALLET_ALREADY_EXISTS

WALLET=<id retornado>

# Aposta (Idempotency-Key obrigatório)
curl -s -X POST $B/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER\",
       \"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",
       \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# 201 {"transactionId":"...","status":"PROCESSED","failureCode":null,"balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
# mesmo request de novo → 200 com idempotentReplay:true; mesma key com payload diferente → 409 IDEMPOTENCY_CONFLICT

# Reversão (exige referenceExternalTransactionId; antes da referência existir → 202 PENDING_REFERENCE)
curl -s -X POST $B/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:rollback-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"rollback-1\",\"playerId\":\"$PLAYER\",
       \"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"ROLLBACK\",
       \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"transaction-123\"}"

# Consultas
curl -s $B/wallets/$WALLET
curl -s "$B/wallets/$WALLET/ledger?limit=50"              # { items, nextCursor } — cursor opaco e estável
curl -s "$B/wallets/$WALLET/ledger?limit=50&cursor=<nextCursor>"
curl -s $B/wagering/transactions/<transactionId>
curl -s $B/providers/provider-a/wagering/transactions/transaction-123

# Reconciliação (nunca corrige; sinaliza, loga e conta em métrica)
curl -s -X POST $B/wallets/$WALLET/reconciliation
# {"walletId":"...","storedBalance":{...},"calculatedBalance":{...},"difference":{"amount":"0.00",...},"consistent":true,"checkedEntries":3,"issues":[]}

# Saúde e métricas (públicos)
curl -s $B/health/live
curl -s $B/health/ready        # 200 {status:"ok",checks:{database,sqs}} | 503 durante shutdown ou dependência fora
curl -s $B/metrics | grep '^wagering_'
```

### Regras de identificação

- UUIDs (`playerId`, `walletId` e os ids nas rotas) são aceitos em qualquer caixa e normalizados para minúsculas antes do hash e das validações. Ou seja, o mesmo id em maiúsculas ou em minúsculas é a mesma operação.
- A `Idempotency-Key` vale **por provider**: dois providers podem usar a mesma string sem colisão. Um conflito (409) nunca expõe transações de outro provider.
- O saldo de uma wallet tem teto de `999999999999999.99`. Um crédito que passaria desse valor é rejeitado com `422 BALANCE_LIMIT_EXCEEDED`, e a wallet continua operando normalmente.

### Mapeamento de status (`POST /wagering/transactions`)

| Situação | HTTP | Pode reenviar a mesma requisição? |
|---|---|---|
| Processada (nova) | 201 | — |
| Replay idempotente de processada | 200 (`idempotentReplay: true`) | sim (é seguro) |
| Aceita, aguardando referência | 202 (`PENDING_REFERENCE`) | sim (o replay devolve o estado atual) |
| Rejeição de negócio | 422 (`error.code` = `failureCode`) | não: corrigir e enviar **nova** transação |
| Wallet inexistente | 422 `WALLET_NOT_FOUND` | não |
| Conflito de idempotência | 409 `IDEMPOTENCY_CONFLICT` | não |
| Payload inválido / header ausente | 400 `VALIDATION_ERROR` / `IDEMPOTENCY_KEY_REQUIRED` | não |
| Falha transitória de infraestrutura | 503 `TRANSIENT_FAILURE` + `Retry-After` (`retryable: true`) | **sim** |

Os `failureCode`s (`INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `BALANCE_LIMIT_EXCEEDED`, `REFERENCE_NOT_FOUND`, `ALREADY_REVERSED`, ...) estão documentados no [`ARCHITECTURE.md`](ARCHITECTURE.md#9-códigos-de-falha-e-mapeamento-http).

### Mensagem SQS (`wager-transactions.fifo`)

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "transaction-123", "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1", "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987", "gameId": "fortune-chimp", "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Use `MessageGroupId = walletId` e `MessageDeduplicationId = messageId`. Um payload inválido vai direto para a DLQ, com o atributo `errorCode`. Uma falha transitória volta para a fila com backoff de visibilidade e, depois de `SQS_MAX_RECEIVE_COUNT` recebimentos, o redrive a move para a DLQ. Rejeições de negócio recebem ack.

---

## Variáveis de ambiente

Todas são validadas na inicialização (`src/bootstrap/config.ts`); uma configuração inválida encerra o processo com a lista de erros. A lista completa, com defaults, está em [`.env.example`](.env.example).

| Variável | Padrão | Uso |
|---|---|---|
| `PORT`, `INSTANCE_ID`, `LOG_LEVEL` | `3000`, hostname, `info` | HTTP, identificação nos logs/métricas |
| `DATABASE_URL` | `postgresql://wagering:wagering@localhost:5432/wagering` | Postgres |
| `DB_POOL_MAX`, `DB_LOCK_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `TX_MAX_ATTEMPTS` | `20`, `5000`, `15000`, `3` | pool, timeouts por transação, retries internos |
| `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `http://localhost:4566`, `us-east-1`, `test`, `test` | LocalStack |
| `SQS_WAGER_QUEUE_NAME`, `SQS_WAGER_DLQ_NAME`, `SQS_EVENTS_QUEUE_NAME` | `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wallet-events.fifo` | filas |
| `SQS_CONSUMER_NAME`, `SQS_MAX_RECEIVE_COUNT`, `SQS_VISIBILITY_TIMEOUT_S`, `SQS_WAIT_TIME_S`, `SQS_BATCH_SIZE` | `wager-transactions-consumer`, `5`, `30`, `20`, `10` | consumer/inbox/redrive |
| `SQS_RETRY_BASE_S`, `SQS_RETRY_MAX_S` | `2`, `300` | backoff de visibilidade |
| `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REF_WORKER_ENABLED` | `true` | liga/desliga cada componente da instância |
| `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_LEASE_MS`, `OUTBOX_RETRY_BASE_MS`, `OUTBOX_RETRY_MAX_MS` | `500`, `50`, `30000`, `1000`, `300000` | publisher do outbox |
| `PENDING_REF_POLL_INTERVAL_MS`, `PENDING_REF_BATCH_SIZE`, `PENDING_REF_LEASE_MS` | `1000`, `20`, `30000` | worker de referências pendentes |
| `PENDING_REF_BASE_DELAY_MS`, `PENDING_REF_MAX_DELAY_MS`, `PENDING_REF_MAX_ATTEMPTS` | `2000`, `300000`, `10` | backoff e expiração (~18,5 min) |
| `SHUTDOWN_GRACE_MS` | `25000` | prazo do graceful shutdown |
| `AUTH_ENABLED`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE`, `AUTH_PROVIDER_CLAIM` | `false`, —, —, —, `provider_id` | autenticação via IdP externo |
| `FAULT_INJECTION_ENABLED`, `FAULT_*` | `false` | injeção de falhas para testes (recusada em `NODE_ENV=production`) |

---

## Estrutura

```
src/
  domain/          Money, Wallet, WalletLedgerEntry, WagerTransaction (máquina de estados), WagerPolicy — sem framework
  application/     use cases (um único ProcessWagerTransaction para HTTP e SQS), portas, eventos, inbox/outbox
  infrastructure/  MikroORM (schemas, repositórios, unit of work, migrations SQL), SQS, pino, prom-client, JWKS
  interface/       controllers HTTP, consumer SQS, workers (outbox publisher, pending references)
  bootstrap/       config (zod), módulos Nest, composição
tests/{unit,integration,concurrency,support}
scripts/           setup de filas, reset do banco de teste, mensagem de exemplo, teste de carga
docker/            init do Postgres (banco de teste) e realm do Keycloak
```
