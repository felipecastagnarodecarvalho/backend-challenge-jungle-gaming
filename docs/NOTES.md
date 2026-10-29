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
