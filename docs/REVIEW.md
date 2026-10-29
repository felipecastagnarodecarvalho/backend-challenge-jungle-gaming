# Revisão técnica — conformidade com `docs/CHALLENGE.md`

> Revisor: agente **Revisor** (auditoria cética, sem alterar código-fonte). Data: 2026-10-29.
> Base revisada: `c993098` (HEAD). Método: leitura de todo `src/`, migrations e suítes de teste; execução de todas as suítes; sondas HTTP contra o compose em execução (3 instâncias), incluindo corridas entre instâncias e casos-limite de `Money`.

## 1. Resumo

A entrega implementa o desafio de forma completa e acima da média. O desenho é sólido: uma transação SQL por operação, lock pessimista por wallet, idempotência re-checada sob o lock, `ON CONFLICT DO NOTHING` para a corrida residual, inbox e outbox transacionais e invariantes duplicadas no schema (CHECKs, FKs compostas, índice único parcial, triggers append-only e um constraint trigger diferido saldo⇔ledger). Os 8 cenários de concorrência rodam com processos reais e passam. A documentação é honesta e detalhada.

**Não encontrei falha eliminatória.** Encontrei dois bugs reais de correção, ambos reproduzidos contra o stack em execução e ambos fáceis de corrigir:

1. **UUID em maiúsculas** em `playerId` faz toda operação ser rejeitada com `WALLET_PLAYER_MISMATCH`. Isso vale até para a wallet criada com aquele mesmo `playerId`. Em `walletId`, a diferença de caixa produz `REFERENCE_MISMATCH` ou um falso `409`.
2. **Limite de `Money` (15 dígitos inteiros) menor que o do banco (`NUMERIC(20,2)`, 18 dígitos).** Um crédito que leva o saldo acima de 999.999.999.999.999,99 é aceito e commitado. Depois disso a wallet fica **inutilizável**: toda escrita seguinte devolve 500, porque o mapper reidrata o saldo com o contrato de entrada.

Há ainda um ponto de segurança restrito ao modo com auth: a idempotency key é global e não fica escopada por provider. Ver F3.

**Nota estimada: 92/100**, mais os dois diferenciais (teste de carga e autenticação via Keycloak) entregues.

## 2. Execução das verificações (resultados reais)

| Comando | Resultado |
|---|---|
| `docker compose ps` | postgres, localstack e app-1..3 `healthy` |
| `GET /health/live` · `GET /health/ready` (3001) | `200 {"status":"ok"}` · `200`, DB `up` 2 ms, SQS `up` 9 ms |
| `bun run typecheck` | limpo (exit 0) |
| `bun run lint` | `Checked 169 files … No fixes applied` (exit 0) |
| `bun run test:unit` | **223 pass / 0 fail** (20 arquivos, 0,9 s) |
| `bun run test:reset && bun run test:integration` | **76 pass / 0 fail** (14 arquivos, 45,9 s) |
| `bun run test:concurrency` | **11 pass / 0 fail** (8 arquivos, 62,2 s). 6a: 300/300 eventos sem duplicata; 8: 66 requisições refeitas em outra instância |

Os números conferem com o que o README declara (223 / 76 / 11).

**Sondas próprias contra o compose** (scripts descartáveis no scratchpad, fora do repositório):

- Corrida da §8 em **30 wallets** (2 BETs de 80,00 sobre 100,00, cada uma enviada 5× alternando as 3 instâncias): 0 anomalias. Em todas houve exatamente 1 PROCESSED, 1 REJECTED, saldo final 20,00, 2 lançamentos, reconciliação `consistent` e saldo idêntico em todos os replays.
- **50× a mesma BET** nas 3 instâncias: 1 `transactionId`, 1 débito, 49 replays, todos com saldo 75,00.
- **Mesma key com `walletId`s diferentes** em paralelo (caminho `ON CONFLICT` → retry), 20 rodadas: 0 erros 5xx; o resultado é sempre criação, replay ou 409.
- `Money` (via `POST /wallets`): rejeitou corretamente `"1."`, `".5"`, `"+1.00"`, `"01.00"`, `" 1.00"`, `"1.00 "`, `"1e2"`, `"1E2"`, `"NaN"`, `"Infinity"`, `""`, `"-1.00"`, `"-0.00"`, `"1.001"`, `"1.5"`, `"1"`, `"0x10"`, `"1,00"`, dígito full-width, número JSON `100` e moeda `"brl"`. Aceitou `"0.00"` e `"999999999999999.99"`. Rejeitou `"1000000000000000.00"` (400).
- Regras de negócio ponta a ponta: todos os códigos esperados (ver checklist). Paginação por cursor estável, cursor inválido → 400, reconciliação `consistent`.

## 3. Estimativa de nota (seção 14)

| Área | Máx. | Estimado | Justificativa |
|---|---|---|---|
| Correção financeira | 20 | **18** | `Money` exato e estrito, ledger imutável e encadeado (estrutural e no banco), reversões únicas, reconciliação que loga, conta e sinaliza. Descontos por F1 (UUID com caixa diferente rejeita operações legítimas) e F2 (wallet inutilizada acima de 10^15). |
| Concorrência | 20 | **19** | `FOR UPDATE` por wallet, idempotência sob lock, `UNIQUE(wallet_id, wallet_version)` contra lost update, ≥3 instâncias reais testadas, sem lock global. Desconto pela fila em memória sem limite e sem *backpressure* na hot wallet (documentada; p95 da hot wallet ~3,4 s na carga). |
| Idempotência | 15 | **13** | Persistente, hash canônico documentado com vetor de teste, replay com o saldo original, conflito ≠ replay, cruzado HTTP↔SQS. Descontos: hash e comparação sensíveis à caixa do UUID (F1) e key não escopada por provider (F3). |
| Mensageria e falhas | 15 | **14** | Inbox na mesma transação, ack só após o commit, poison direto para a DLQ, transitório com backoff e redrive, SIGTERM devolvendo a visibilidade, outbox com `SKIP LOCKED` + lease e crash testado. Desconto: sem *heartbeat* de visibilidade (F5); erro permanente inesperado só chega à DLQ via redrive. |
| Modelagem e arquitetura | 10 | **9** | Construtores privados e factories, `rehydrate` sem validação, máquina de estados espelhada em trigger, portas e regra de dependência testada. Desconto: o mapper reidrata com o **contrato de entrada** `Money.from` (é a origem de F2) e contraria o "rehydrate não revalida". |
| Testes | 10 | **9** | Integração real (Postgres + LocalStack), 8 cenários multi-processo com kill, injeção de falhas, invariante final em todos os testes, determinismo (PRNG semeado, `waitFor`). Falta cobertura de normalização de UUID e de limites de valor (as lacunas que deixaram F1/F2 passarem). |
| Observabilidade | 5 | **5** | Logs JSON com os 5 campos, redaction de payload monetário, todas as métricas pedidas, live/ready separados. |
| Documentação | 5 | **5** | README com setup e comandos corretos (conferidos). `ARCHITECTURE.md` cobre ORM, mapeamento do `Money`, estratégia transacional, auth, taxonomia de falhas, transições, trade-offs e 15 limitações honestas. |
| **Total** | **100** | **92** | |

**Eliminatórias:** nenhuma acionada. Dinheiro nunca passa por `number`; não há saldo negativo por corrida (CHECK + lock + testes); não há débito ou crédito duplicado (50×, cruzado, crash antes do ack); a idempotência está no banco; os testes são multi-instância; não há publicação antes do commit (só outbox); o ledger é auditável; não há mocks nas suítes de integração e concorrência.

**Diferenciais:** teste de carga (`bun run test:load`, `docs/LOAD_TEST.md` com ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de lock, outbox lag e uma seção de análise e limitações honesta) ✅. Autenticação com Keycloak via JWKS, desligada por padrão ✅. Double-entry ❌ (opcional, declarado).

## 4. Checklist de requisitos

Legenda: ✅ atendido · ⚠️ parcial ou com ressalva · ❌ ausente ou errado.

### 4.1 Restrições invioláveis (§5)

| # | Requisito | Status | Evidência |
|---|---|---|---|
| 1 | Sem `number` para dinheiro | ✅ | `src/domain/money/money.ts:32,61-71` (decimal.js + regex); `mappers.ts:22-28` recusa `number`; leituras com `::text` (`mikro-read-models.ts:69,85-86,108`) |
| 2 | Sem cache em memória como garantia de idempotência | ✅ | `wager_tx_idempotency_key_uk`/`provider_external_uk` (`Migration…CoreTables.ts:71-72`); `KeyedSerializer` é só otimização (`keyed-serializer.ts`) |
| 3 | Não confiar só no FIFO | ✅ | Lock + unicidade no banco; FIFO é otimização (`ARCHITECTURE.md` §5/§7) |
| 4 | Não publicar antes do commit | ✅ | Eventos só vão para o outbox na mesma transação (`wager-evaluator.ts:162-163`); o publisher lê linhas commitadas (`publish-outbox-batch.use-case.ts:33`) |
| 5 | Não sobrescrever ou excluir o ledger | ✅ | Domínio sem setters + `Object.freeze` (`wallet-ledger-entry.ts:44`); triggers `ledger_forbid_update_delete`/`truncate` (`Migration…IntegrityTriggers.ts:18-21`) |
| 6 | Sem lock global | ✅ | `findByIdForUpdate` por linha (`mikro-wallet.repository.ts:18-25`); `KeyedSerializer` por chave e por processo |
| 7 | Sem read→calc→update sem controle | ✅ | `FOR UPDATE` + `saveBalance` guardado por versão (`mikro-wallet.repository.ts:32-41`) + `UNIQUE(wallet_id, wallet_version)` |
| 8 | Correta com várias instâncias | ✅ | `tests/concurrency/*` (até 3 processos reais); sondas próprias nas 3 instâncias do compose |
| 9 | Unicidade, imutabilidade e não-negatividade no schema | ✅ | CHECKs `balance >= 0`, ledger `>= 0`, aritmética, `UNIQUE(player_id,currency)`, `UNIQUE(wallet_id,transaction_id)`, reversão única parcial, triggers de imutabilidade e transição, trigger diferido saldo⇔ledger (`Migration…CoreTables.ts:21-25,55-78,100-110`; `Migration…IntegrityTriggers.ts`). Ressalva menor em F7 |

### 4.2 Modelo de domínio (§6)

| Requisito | Status | Evidência |
|---|---|---|
| Construtor privado + factories; `rehydrate` não revalida | ⚠️ | Todas as classes seguem o padrão (`money.ts:51`, `wallet.ts:35`, `wager-transaction.ts:72`, `wallet-ledger-entry.ts:33`, `inbox-message.ts:20`, `outbox-message.ts:35`, `integration-event.ts:47`). **Porém** `mappers.ts:27` reidrata valores persistidos com `Money.from` (contrato de entrada, ≤15 dígitos) → F2 |
| `Money` imutável, operações da interface, `assertSameCurrency` privado | ✅ | `money.ts:90-143` |
| Escala fixa 2; rejeita NaN, Infinity, notação científica, vazio, >2 casas e negativos | ✅ | `money.ts:35,66`; testado em `tests/unit/domain/money.test.ts:13-30` e pelas sondas (§2) |
| Moedas diferentes → erro de domínio; modelo multi-moeda | ✅ | `CurrencyMismatchError` (`money.ts:17,139-143`); FK composta `(wallet_id,currency)` |
| Domínio sem ORM/Nest | ✅ | `tests/unit/architecture.test.ts` (regra de dependência) |
| Wallet: 1 por player+moeda | ✅ | `wallets_player_currency_uk`; 409 (`create-wallet.use-case.ts:112-114`); sonda: maiúscula/minúscula → 409 |
| Wallet: saldo ≥ 0, ledger em toda alteração (e vice-versa) | ⚠️ | `debit/credit` devolvem a entrada (`wallet.ts:112-145`); trigger diferido garante "saldo ⇒ ledger". O "ledger ⇒ saldo" não é garantido no banco (F7) |
| `version` = 1 na criação, +1 só quando o saldo muda | ✅ | `wallet.ts:60,128`; trigger `wallets_guard_update` (`IntegrityTriggers.ts:41-53`) |
| WagerTransaction: estados, transições explícitas, terminais lançam `InvalidTransactionStateError` | ✅ | `wager-transaction.ts:62-70,262-385`; espelhado no trigger `wager_tx_guard` (`IntegrityTriggers.ts:79-100`) |
| `isTerminal/affectsBalance/requiresReference/matchesPayload/ledgerDirectionFor` | ✅ | `wager-transaction.ts:336-379` |
| OPENING interno, não submetível | ✅ | `wager-request.schema.ts:24` (enum), `wager-transaction.ts:102-111`; CHECK `wager_tx_opening_internal_ck`; sonda → 400 |
| Mesma key + payload diferente = conflito | ✅ | `process-wager-transaction.use-case.ts:131-139`; sonda → 409 `PAYLOAD_MISMATCH` |
| LedgerEntry imutável estruturalmente; `create` valida a aritmética | ✅ | `wallet-ledger-entry.ts:48-70` |
| ≤ 1 lançamento por transação/wallet; LOSS e REJECTED sem ledger | ✅ / ⚠️ | `ledger_wallet_transaction_uk`; o código só gera entrada em `APPLY` (`wager-evaluator.ts:80-90`). Não há guarda no banco contra lançamento de transação não-PROCESSED (F7) |
| Inbox/Outbox com a API pedida | ✅ | `inbox-message.ts` (`receive/rehydrate/isProcessed/markProcessed`); `outbox-message.ts` (`enqueue/rehydrate/isPending/isDue/markPublished/scheduleRetry`) |
| Inbox + saldo + ledger + outbox na mesma transação SQL | ✅ | `process-wager-transaction.use-case.ts:62-69,82-158`; `tests/integration/process-wager.atomicity.test.ts` (falha injetada após o ledger e no outbox) |

### 4.3 Regras de negócio (§7)

| Regra | Status | Evidência (código · teste/sonda) |
|---|---|---|
| BET débito / insuficiente → REJECTED | ✅ | `wager-policy.ts:101-113` · sonda 422 `INSUFFICIENT_FUNDS` com saldo |
| WIN crédito, pode referenciar BET da rodada | ✅ | `wager-policy.ts:29` · sonda 201 |
| LOSS sem saldo e sem ledger | ✅ | `wager-policy.ts:96-99` · sonda 201 com saldo inalterado |
| REFUND crédito, só BET, uma vez | ✅ | `wager-policy.ts:31,89` · sondas `ALREADY_REVERSED`, `INVALID_REFERENCE_KIND` |
| ROLLBACK inverso da referência (BET/WIN/REFUND) | ✅ | `wager-transaction.ts:368-375` · sonda: ROLLBACK de WIN debita |
| R1 reversões exigem referência | ✅ | schema `crossRules` + `wager-transaction.ts:113` + CHECK `wager_tx_reference_required_ck` |
| R2 mesmo provider/player/wallet/moeda/rodada | ✅ | `wager-policy.ts:65-73` · sonda `REFERENCE_MISMATCH` (outra rodada) |
| R3 tipos permitidos | ✅ | `wager-policy.ts:26-33,74-76` |
| R4 não reverter duas vezes | ✅ | Interpretação estrita (qualquer reversão processada), documentada em `ARCHITECTURE.md` §15.6; índice parcial `wager_tx_single_reversal_uk` |
| R5 valor igual | ✅ | `wager-policy.ts:86-88` · sonda `AMOUNT_MISMATCH` |
| R6 REJECTED não altera saldo nem ledger | ✅ | `wager-evaluator.ts:101-110` |
| R7 replay devolve resultado e saldo originais | ✅ | `result_balance_amount` (`wager-result.ts:37-50`) · sonda: replay após outra BET devolve 70,00 (não 50,00) |
| R8 referência ausente → PENDING_REFERENCE | ✅ | `wager-evaluator.ts:111-121` · sonda 202 e replay 202 |
| R9 reversão negativa com código distinto e auditável | ✅ | `REVERSAL_INSUFFICIENT_FUNDS` (`wager-policy.ts:105-109`) · sonda 422 |
| 7.1 worker agendado, backoff exponencial, limite e evento na expiração | ✅ | `reference-retry-policy.ts` (2 s→300 s, 10 tentativas ≈ 18,5 min); `wager-evaluator.ts:122-142` (`REFERENCE_NOT_FOUND` + `WagerTransactionRejected`); `SKIP LOCKED` + lease (`mikro-wager-transaction.repository.ts:126-143`) |
| 7.2 taxonomia de `failureCode` documentada | ✅ | `failure-code.ts`; `ARCHITECTURE.md` §9 |

### 4.4 Concorrência (§8)

| Requisito | Status | Evidência |
|---|---|---|
| Unidade = walletId; estratégia justificada | ✅ | `ARCHITECTURE.md` §4-5 |
| Cenário obrigatório 100 / 2×80 | ✅ | `tests/concurrency/02-two-bets-same-wallet.test.ts` (20 wallets) + sonda própria (30 wallets, 3 instâncias, retries): 1 PROCESSED, 1 REJECTED, 20,00, 1 débito |
| Broker não é a garantia | ✅ | Invariantes no banco |

### 4.5 API HTTP (§9)

| Requisito | Status | Evidência |
|---|---|---|
| `POST /wallets` com OPENING + CREDIT na mesma transação; duplicata → 409 | ✅ | `create-wallet.use-case.ts:58-102`; `tests/integration/create-wallet.test.ts` (inclui criação concorrente) |
| `GET /wallets/:id`, `/ledger` com cursor opaco e estável | ✅ | `ledger-cursor.ts` (base64url de `wallet_version`); keyset em `mikro-read-models.ts:83-104`; teste com 120 entradas |
| `GET /wagering/transactions/:id`, `GET /providers/:p/wagering/transactions/:ext` | ✅ | controllers; sondas 200/400/404 |
| `Idempotency-Key` obrigatório | ✅ | `wagering.controller.ts:34-40` · sonda 400 `IDEMPOTENCY_KEY_REQUIRED` |
| Hash canônico (chaves ordenadas), sem header nem transporte, documentado | ✅ / ⚠️ | `canonical-json.ts`, `payload-hash.ts:15-32`, vetor de teste. Ressalva: UUIDs não normalizados entram no hash (F1) |
| Replay `idempotentReplay:true`; conflito ≠ replay | ✅ | sondas 200/true; 409 |
| Status distintos e consistentes | ✅ | 400 inválido · 409 conflito · 422 negócio · 202 pendente · 503 transitório + `Retry-After` · 500 interno (`presenters.ts`, `app-exception.filter.ts:62-95`) |
| Reconciliação: log + métrica + flag, sem correção | ✅ | `reconcile-wallet.use-case.ts:24-67`; snapshot `REPEATABLE READ READ ONLY`; teste com corrupção forçada |
| Health live/ready sem auth | ✅ | `health.controller.ts` (`@Public`), ready checa DB + SQS e devolve 503 no shutdown |

### 4.6 SQS (§10)

| Requisito | Status | Evidência |
|---|---|---|
| Mesmo use case do HTTP | ✅ | `wager-transactions.consumer.ts:162-172` |
| Inbox persistente `(consumerName, messageId)` | ✅ | PK `inbox_messages_pk`; `mikro-inbox.repository.ts:15-33`; teste de redelivery com dedup ids distintos |
| Ack só após o commit | ✅ | `consumer.ts:162-183` (delete após `execute` devolver); cenário 5 com `exit(137)` |
| Negócio → ack; transitório → retry com backoff; permanente → DLQ | ✅ / ⚠️ | `message-classifier.ts:18-38`. Poison vai direto para a DLQ; erro permanente **inesperado** (bug/integridade) segue retry e chega à DLQ via redrive |
| Limite de tentativas → DLQ | ✅ | redrive `maxReceiveCount` (`queue-provisioner.ts:43`); teste com `ApproximateReceiveCount` crescente |
| SIGTERM: concluir ou devolver a visibilidade | ✅ | `consumer.ts:72-88` (visibility 0 nos não iniciados, grace, liberação dos restantes); `graceful-shutdown.test.ts`; verificado em container (NOTES) |
| Redelivery sem duplicar efeito | ✅ | cenários 4 e 5, `sqs-consumer.test.ts` |

### 4.7 Outbox e eventos (§11)

| Requisito | Status | Evidência |
|---|---|---|
| Atomicidade de tx + saldo + ledger + inbox + evento | ✅ | ver 4.2 |
| Publishers concorrentes sem perda nem duplicação indefinida | ✅ | `claimDue` `SKIP LOCKED` + lease (`mikro-outbox.repository.ts:22-40`); `markPublished` idempotente; cenário 6a/6b |
| Crash após o commit e antes da publicação → outra instância publica | ✅ | `restart-recovery.test.ts`, cenário 6b |
| 4 eventos mínimos com a semântica correta | ✅ | `events.ts`; `WalletBalanceChanged` só com ledger (`wager-evaluator.ts:89`); Processed inclui LOSS; Rejected na expiração; PendingReference |
| `IntegrationEvent` abstrata, subclasses com `eventType/version` no tipo, `data` com `MoneyProps` | ✅ | `integration-event.ts:34-75`; `events.ts:47-50` etc.; `OutboxMessage.enqueue` faz round-trip JSON (`outbox-message.ts:54`) |

### 4.8 Observabilidade (§12)

| Requisito | Status | Evidência |
|---|---|---|
| Logs JSON com correlationId, messageId, transactionId, walletId, providerId | ✅ | `process-wager-transaction.use-case.ts:191-222`; child loggers do consumer (`consumer.ts:152-157`) |
| Sem payload financeiro nos logs | ✅ | `REDACT_PATHS` (`logger.ts`) |
| Métricas: tx por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência | ✅ | `prometheus-metrics.ts:22-122,141-188` |
| Health live/ready separados | ✅ | `health.controller.ts` |

### 4.9 Testes obrigatórios (§13)

| Item | Status | Onde |
|---|---|---|
| Unit: Money, Wallet, regras BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, key com payload divergente | ✅ | `tests/unit/domain/*`, `tests/unit/application/process-wager.idempotency.test.ts` |
| Integração: migrations + constraints | ✅ | `migrations.test.ts` (up/down/up), `constraints.test.ts` |
| Atomicidade wallet/ledger/inbox/outbox | ✅ | `process-wager.atomicity.test.ts` |
| Inbox e redelivery; publishers concorrentes; retry e DLQ; recuperação após restart | ✅ | `sqs-consumer.test.ts`, `outbox-publisher.test.ts`, `restart-recovery.test.ts` |
| Concorrência 1–8 com paralelismo real | ✅ | `tests/concurrency/01..08` (processos `bun src/main.ts`) |
| Invariante final `balance == ledger` | ✅ | `tests/support/invariants.ts` (`assertWalletConsistent`) |
| Lacunas | ⚠️ | Sem teste de normalização de UUID (F1) nem de limite de valor e overflow (F2) |

### 4.10 Documentação e qualidade

| Item | Status | Evidência |
|---|---|---|
| README com setup e comandos (conferidos) | ✅ | `README.md` §Pré-requisitos/Subindo/Comandos/Testes |
| ARCHITECTURE: ORM, Money, estratégia transacional, auth, trade-offs, limitações | ✅ | `ARCHITECTURE.md` §2, §3, §4, §12, §15, §16 |
| Comentários relevantes nas funções (não ruído) | ✅ | TSDoc explicam o *porquê* (ex.: `process-wager-transaction.use-case.ts:31-45`, `mikro-unit-of-work.ts:26-32`, `keyed-serializer.ts`) |
| Teste de carga com os itens pedidos | ✅ | `docs/LOAD_TEST.md` |
| Auth com IdP externo | ✅ | `jwks-provider-identity.ts`, `docker/keycloak/wagering-realm.json`, `auth.test.ts` |

## 5. Achados (ordem de severidade)

### F1 — ALTA · UUIDs não normalizados: operações legítimas rejeitadas como `WALLET_PLAYER_MISMATCH`/`REFERENCE_MISMATCH`, e falso 409

- **Onde:** `src/interface/shared/wager-request.schema.ts:20-21` (`z.uuid()` aceita maiúsculas e não normaliza); `src/domain/wager/wager-policy.ts:46,66-67` (comparação de strings com valores vindos do banco, que o Postgres devolve em minúsculas); `src/application/wager/payload-hash.ts:15-26` (o hash usa a string crua); `src/interface/http/controllers/wallets.controller.ts:12` (a criação aceita maiúsculas e as **devolve**).
- **Cenário reproduzido no compose:**
  1. `POST /wallets` com `playerId` em maiúsculas → 201, e a resposta ecoa o id em maiúsculas.
  2. Uma BET com **exatamente o mesmo `playerId`** → `422 REJECTED WALLET_PLAYER_MISMATCH`. Quem integra em maiúsculas nunca consegue apostar.
  3. A rejeição fica gravada e presa à key. Reenviar em minúsculas com a mesma key dá `409 PAYLOAD_MISMATCH`.
  4. BET com `walletId` em maiúsculas é processada. O replay com o mesmo id em minúsculas, porém, dá `409 PAYLOAD_MISMATCH`, e uma reversão com `walletId` em maiúsculas contra referência gravada em minúsculas dá `REFERENCE_MISMATCH`.
- **Impacto:** nenhuma perda de dinheiro, mas há rejeições indevidas e permanentes e conflitos falsos, justamente nos eixos avaliados (correção e idempotência).
- **Correção:** normalizar na borda, antes do hash: `z.uuid().transform((v) => v.toLowerCase())` para `playerId`/`walletId` (HTTP, SQS e `POST /wallets`). Opcionalmente, `WagerTransaction.create`/`Wallet.open` podem lançar erro para UUID não canônico. Adicionar testes de integração com UUID em maiúsculas: criação, BET, replay e reversão.

### F2 — MÉDIA/ALTA · Teto do `Money` (15 dígitos) < teto do banco (18 dígitos): wallet inutilizada após um crédito grande

- **Onde:** `src/domain/money/money.ts:35` (`AMOUNT_PATTERN` com até 15 dígitos inteiros) usado em `src/infrastructure/persistence/mappers.ts:27` para **reidratar** `balance`, `amount` e `result_balance_amount`; `NUMERIC(20,2)` em `Migration…CoreTables.ts:17,40,46,94-97`.
- **Cenário reproduzido:**
  1. Wallet aberta com `999999999999999.99`.
  2. 1 WIN de `999999999999999.99` → 201 e saldo `1999999999999999.98` gravado (cabe em `NUMERIC(20,2)`).
  3. A próxima operação, **de qualquer tipo**, devolve `500 INTERNAL_ERROR`. O log mostra `InvalidMoneyError at mappers.ts:49 ← findByIdForUpdate`.
  4. A wallet fica permanentemente travada para escrita. Via SQS as mensagens entram em retry e vão para a DLQ. No worker de pendências, `failItem` também falha ao carregar a wallet e o item volta a cada lease, para sempre.
- **Também:** acima de 10^18 o Postgres lança `22003` (`numeric_value_out_of_range`). Esse código não é classificado (`pg-error-classifier.ts:59-83`) e vira 500 genérico.
- **Correção:** (a) reidratar valores persistidos com um parser próprio, sem o teto do contrato de entrada (por exemplo `Money.fromPersisted` com até 18 dígitos); **e** (b) definir um teto de saldo explícito e coerente: `CHECK (balance <= 999999999999999.99)` em `wallets` mais uma decisão no `WagerPolicy` (por exemplo `BALANCE_LIMIT_EXCEEDED`, REJECTED, auditável), em vez de deixar o banco estourar. Adicionar testes de limite.

### F3 — MÉDIA (só com `AUTH_ENABLED=true`) · Idempotency key global: squatting e vazamento entre providers

- **Onde:** `UNIQUE (idempotency_key)` global (`Migration…CoreTables.ts:71`); a busca por key não filtra provider (`process-wager-transaction.use-case.ts:119-138`); `wagering.controller.ts:41` só confere `body.providerId`; `presenters.ts:52` devolve `existingTransactionId`.
- **Cenário:** `provider-b`, autenticado, envia uma operação própria com `Idempotency-Key: provider-a:tx-999`.
  - Se `provider-a` já usou a key: `409` com o `existingTransactionId` de outro provider (vazamento de id).
  - Se ainda não usou: a key fica tomada, e a requisição legítima de `provider-a` com a key padrão recomendada pelo enunciado recebe `409` para sempre (negação de serviço entre tenants).
- **Correção:** escopar a unicidade por provider (`UNIQUE (provider_id, idempotency_key)` e lookup filtrado por `providerId`), ou exigir com auth ligada que a key comece por `"{providerId}:"`. Não devolver `existingTransactionId` de outro provider.

### F4 — BAIXA · Resultados de negócio via SQS sem retorno ao provedor

- **Onde:** `message-classifier.ts:19-22`; `process-wager-transaction.use-case.ts:143-146`.
- **Cenário:** uma mensagem SQS com `WALLET_NOT_FOUND` ou com conflito de idempotência é ackada e só fica em log e métrica. Nenhum evento é publicado, e o provedor que integra apenas por fila nunca sabe da recusa. A limitação está documentada para `WALLET_NOT_FOUND` (`ARCHITECTURE.md` §15.5), mas não para o conflito.
- **Correção:** publicar um `WagerTransactionRejected` sem linha de transação (`transactionId: null`, `failureCode`) pelo outbox, ou ao menos documentar o caso do conflito.

### F5 — BAIXA · Sem *heartbeat* de visibilidade no consumer

- **Onde:** `wager-transactions.consumer.ts:139-224` (visibility fixa de 30 s; `KeyedSerializer` sem limite à frente).
- **Cenário:** sob uma hot wallet, uma mensagem pode esperar mais que a visibility timeout na fila em memória. Ela reaparece para outra instância, que trava no INSERT do inbox até o commit e devolve `DUPLICATE`, então a correção se mantém. Mas o `ApproximateReceiveCount` sobe a cada estouro, e após `maxReceiveCount` (5) uma mensagem **válida** pode ser movida para a DLQ pelo redrive.
- **Correção:** estender a visibilidade periodicamente enquanto a mensagem estiver em processamento (`ChangeMessageVisibility` a cada ~visibility/2), ou limitar a fila por wallet com *load shedding* (já citado como próximo passo em `ARCHITECTURE.md` §15.2).

### F6 — BAIXA · Erros permanentes inesperados no consumer seguem o caminho de retry

- **Onde:** `message-classifier.ts:33-37` (`IntegrityViolationError`, `ConcurrencyInvariantError` e bugs → `RETRY`).
- **Impacto:** chegam à DLQ só depois de N tentativas com backoff (até 300 s cada), segurando o grupo FIFO da wallet nesse intervalo. O enunciado pede "permanentes → DLQ". Hoje isso é atendido de forma indireta, e não fica registro `FAILED` no banco.
- **Correção:** classificar `IntegrityViolationError`/`ConcurrencyInvariantError` como permanentes (DLQ imediata com `errorCode`). Opcionalmente, persistir `FAILED` quando houver linha de transação.

### F7 — BAIXA · Duas garantias só de aplicação

- **Onde:** `Migration…IntegrityTriggers.ts:61-77` (o trigger diferido só dispara em `INSERT/UPDATE` de `wallets`).
- **Cenário:** um INSERT em `wallet_ledger_entries` sem UPDATE da wallet passa pelo trigger de cadeia e commita. O "ledger ⇒ saldo" fica sem garantia no banco, e a divergência só aparece na reconciliação. Também não há guarda no banco que impeça um lançamento para uma transação que não esteja `PROCESSED`.
- **Correção:** um constraint trigger diferido em `wallet_ledger_entries` (`AFTER INSERT`) que verifica `wallets.version = NEW.wallet_version AND wallets.balance = NEW.balance_after` no commit, ou que a última entrada bate com a wallet, e que `wager_transactions.status = 'PROCESSED'`. O trigger de cadeia também poderia exigir `wallet_version = anterior + 1`.

### F8 — BAIXA · `ON CONFLICT DO NOTHING` sem alvo

- **Onde:** `mikro-wager-transaction.repository.ts:42-45` (`INSERT_SQL`).
- **Impacto:** engole conflito de **qualquer** constraint única, inclusive `wager_tx_single_reversal_uk` e PK, e o trata como corrida de idempotência. Uma violação real que não seja de idempotência viraria 3 retries e depois `503 retryable`, que o provedor reenviaria indefinidamente. Hoje não é alcançável, porque o lock da wallet e `hasProcessedReversal` impedem.
- **Correção:** `ON CONFLICT (idempotency_key) DO NOTHING` e tratar `provider_external_uk` via `UniqueViolationError` (já está em `RACE_CONSTRAINTS`), ou checar a causa após 0 linhas.

### F9 — INFO · Hot wallet sem *backpressure*

`KeyedSerializer` é uma fila ilimitada e o HTTP não tem timeout. A carga mostra p50 de 3,4 s e p99 de 7 s na hot wallet (`docs/LOAD_TEST.md`). A limitação está documentada (`ARCHITECTURE.md` §15.1-2). Na apresentação, convém mostrar o próximo passo: limite por wallet com 503 `retryable`.

### Pontos fortes (para a apresentação)

- Idempotência re-checada **depois** do lock e uso de `result_balance_amount` para o replay. A sonda confirmou que o replay devolve 70,00 mesmo depois de outra BET ter levado o saldo a 50,00.
- Schema defensivo excepcional: o constraint trigger **diferido** saldo⇔ledger, `UNIQUE(wallet_id, wallet_version)` como prova estrutural contra lost update, FKs compostas de moeda e de wallet, e a máquina de estados replicada em trigger.
- Testes de concorrência com **processos reais**, kill no meio da carga e falhas injetadas (`exit(137)` após o commit, morte após o claim do outbox).
- O teste de carga levou a uma correção real (starvation do pool, resolvida com `KeyedSerializer`), registrada com antes e depois e uma análise honesta.

## 6. Must-fix antes da entrega

1. **F1:** normalizar `playerId`/`walletId` para minúsculas na borda (HTTP, SQS e `POST /wallets`) antes do hash, com testes de integração de UUID em maiúsculas.
2. **F2:** reidratar valores persistidos sem o teto do contrato de entrada e impor um teto de saldo coerente (CHECK no banco mais rejeição de negócio auditável), com teste de limite.
3. **F3** (se a autenticação for demonstrada): escopar a idempotency key por provider ou exigir o prefixo `providerId:` com auth ligada, e não expor `existingTransactionId` de outro provider.

Recomendados, se houver tempo: F6 (DLQ imediata para erro de integridade) e F5 (heartbeat de visibilidade).
