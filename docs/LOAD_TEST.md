# Teste de carga

> Gerado por `bun run test:load` (`scripts/load-test.ts`) — execução `mvu41h8t` em 2026-10-29T22:27:00.668Z.
> Dados brutos: `load-results/run-mvu41h8t.json` (não versionado). A seção **Análise** é escrita à mão e preservada entre execuções.

## Ambiente

| Item | Valor |
|---|---|
| CPU | AMD Ryzen 7 5700U with Radeon Graphics (16 threads lógicas) |
| RAM | 19.4 GB |
| SO do host | Windows_NT 10.0.26200 (win32/x64) |
| Bun (gerador de carga) | 1.4.4 |
| Docker | 29.8.2 (linux/amd64) — Docker Desktop (WSL2) |
| Imagens | localstack/localstack:3.8, postgres:16-alpine, wagering-app:local |
| Topologia | 3 instâncias (`app-1..3`, cada uma com HTTP + consumer SQS + outbox publisher + worker de pendências), 1 PostgreSQL 16, 1 LocalStack 3.8 — todos no mesmo host |
| Pool de conexões | `DB_POOL_MAX=20` por instância; `lock_timeout=5s` |

## Metodologia

- **Parâmetros:** duração A = 60s, duração B = 30s, concorrência = 64 workers virtuais, 200 wallets (+1 hot) com saldo 1.000.000,00, fração hot no cenário A = 0.1, 5000 mensagens SQS.
- **Cenário A — HTTP closed-loop:** cada worker escolhe uma wallet (10% na hot wallet) e envia BET (~70%), WIN referenciando a última BET do worker (~20%), LOSS (~5%) e REFUND da última BET (~5%, uma única vez); ~2% das requisições são reenvios idênticos (medem replay). Round-robin entre as 3 instâncias. Latência medida no cliente (`performance.now()`), do envio ao corpo completo.
- **Cenário B — hot wallet:** 100% das requisições em uma única wallet — mede o custo da serialização pelo lock pessimista por wallet.
- **Cenário C — SQS:** 5000 BETs enviadas com `SendMessageBatch` (8 produtores paralelos, `MessageGroupId` = wallet, 50 grupos); mede o tempo até a fila ficar vazia (visíveis + em voo = 0) ⇒ throughput de consumo das 3 instâncias.
- **Coleta:** deltas de `/metrics` somados das 3 instâncias por cenário; `wagering_outbox_oldest_pending_age_seconds` amostrado a cada 1 s durante toda a execução; percentis de histograma reportados como limite superior do bucket.
- **Validação pós-carga:** `POST /wallets/:id/reconciliation` em todas as wallets do teste + verificação SQL independente (saldo = soma do ledger).
- **Erro** = 5xx + erros de rede. 422 (rejeição de negócio), 409 e 202 **não** são erros de infraestrutura e são reportados à parte.

## Resultados — HTTP

| Cenário | Requisições | Duração (s) | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro |
|---|---|---|---|---|---|---|---|---|
| A — HTTP misto (closed loop) | 8108 | 61.2 | **132.6** | 106.2 | 3369.2 | 5944.7 | 7308.2 | 0.00% |
| A — só wallets frias | 7311 | 61.2 | **119.5** | 96.6 | 388.2 | 688.6 | 1509.5 | 0.00% |
| A — só hot wallet | 797 | 61.2 | **13.0** | 3393.5 | 6378.9 | 6975.2 | 7308.2 | 0.00% |
| B — hot wallet única | 1628 | 31.3 | **52.1** | 1158.0 | 1678.0 | 1834.4 | 1946.7 | 0.00% |

Distribuição de respostas:

| Cenário | 2xx novo | 200 replay | 202 pendente | 422 negócio | 409 conflito | outros 4xx | 5xx | rede |
|---|---|---|---|---|---|---|---|---|
| A — HTTP misto (closed loop) | 7956 | 152 | 0 | 0  | 0 | 0 | 0 | 0 |
| B — hot wallet única | 1588 | 40 | 0 | 0  | 0 | 0 | 0 | 0 |

## Resultados — SQS (cenário C)

| Mensagens | Efetivadas no banco | Tempo de envio (s) | Tempo até fila vazia (s) | Throughput de consumo (msg/s) |
|---|---|---|---|---|
| 5000 | 5000 | 6.2 | 87.7 | **57.0** |

## Concorrência (deltas de métricas, 3 instâncias)

| Cenário | Conflitos de lock | Retries internos | Replays | Conflitos de idempotência | Duplicatas inbox | Espera de lock p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|
| A | 0 (timeout 0, deadlock 0) | 0 | 152 | 0 | 0 | ≤ 10 ms | ≤ 250 ms | ≤ 500 ms |
| B | 0 (timeout 0, deadlock 0) | 0 | 40 | 0 | 0 | ≤ 50 ms | ≤ 100 ms | ≤ 100 ms |
| C (SQS) | 0 (timeout 0, deadlock 0) | 0 | 0 | 0 | 0 | ≤ 5 ms | ≤ 5 ms | ≤ 25 ms |

## Outbox lag

| Métrica | Valor |
|---|---|
| Idade do evento pendente mais antigo — p50 / p95 / máx (amostras de 1 s, n=163) | 0.42 s / 0.78 s / 1.46 s |
| Máximo de eventos pendentes observado | 265 |
| Lag de publicação (commit → publish) p50 / p95 — cenário A | ≤ 500 ms / ≤ 1000 ms |
| Lag de publicação p50 / p95 — cenário C | ≤ 500 ms / ≤ 1000 ms |
| Tempo para zerar o outbox após o fim da carga | 0.1 s |

## Consistência pós-carga

| Wallets verificadas | Reconciliação inconsistente | Divergência SQL (saldo ≠ soma do ledger) |
|---|---|---|
| 201 | **0** | **0** |

## Análise

<!-- ANALYSIS:START -->
### Leitura dos números

**Correção primeiro.** Nenhuma execução produziu 5xx, erro de rede, `lock_timeout`, deadlock ou retry interno, e as 201 wallets fecham na reconciliação (API) e na verificação SQL independente (saldo = soma do ledger). Os ~2% de reenvios idênticos voltaram como replay (`200`, `idempotentReplay: true`) e as 5000 mensagens SQS viraram exatamente 5000 transações. Nada se perdeu e nada foi aplicado duas vezes.

**A hot wallet domina a cauda do cenário A, e isso é esperado.** O p95/p99 do cenário A *agregado* (≈3,4 s / 5,9 s) é quase todo da hot wallet: separando as classes, as wallets frias ficam em **p50 ≈ 97 ms / p95 ≈ 390 ms / p99 ≈ 690 ms**, e a hot wallet em p50 ≈ 3,4 s. Pelo desenho, operações da mesma wallet são serializadas: o lock pessimista por linha é o que garante "sem lost update", sem lock global. A vazão de **uma** wallet é limitada a `1 / (duração da transação com o lock)`: ≈52 tx/s com a hot wallet sozinha (B), e só ≈13 tx/s no cenário A, onde cada transação é mais lenta por disputar CPU com o resto da carga. Como o teste é *closed-loop* com 64 workers, quem cai na hot wallet fica preso na fila dela (pela lei de Little, ≈13 tx/s × 3,4 s ≈ 44 workers). Por isso sobra pouca concorrência efetiva para as wallets frias. Num gerador *open-loop* (taxa fixa), a hot wallet saturada cresceria a fila sem limite. A mitigação de produto seria *load shedding*/limite de fila por wallet ou sub-wallets (ver ARCHITECTURE.md).

**Gargalo encontrado e corrigido durante o teste.** A primeira execução (antes da otimização) deu A = 144 req/s com p50 153 ms; B = 47,8 req/s com p95 2,3 s; espera de lock no banco com p95 de até 5 s (encostando no `lock_timeout`); e **outbox lag máximo de 18,9 s, com 3555 eventos pendentes**. A causa: cada requisição esperando o lock da hot wallet segurava uma conexão do pool (20 por instância), o que matava de fome as wallets frias e até o outbox publisher, que precisa de conexão para o *claim*. A correção foi uma fila FIFO **por wallet e por processo** (`KeyedSerializer`) antes de abrir a transação: no máximo uma transação por wallet por instância espera no Postgres, e as demais esperam em memória, sem conexão. Isso é otimização. A garantia entre instâncias continua sendo o `FOR UPDATE` e as constraints, e os 8 cenários de concorrência continuam passando. Depois da mudança:
- espera de lock no banco: p95 caiu de ≤ 5000 ms para ≤ 250 ms (A) e ≤ 100 ms (B);
- outbox lag: máximo de 18,9 s para 1,5 s, p95 de 9,6 s para 0,8 s, pico de pendentes de 3555 para 265;
- p50 de A: de 153 ms para ≈ 91–106 ms; B: de 47,8 para ≈ 52–58 tx/s.

**SQS (≈ 55–63 msg/s).** O consumo é limitado pelo LocalStack, que fica perto de 80% de CPU de um core em `docker stats` mesmo ocioso, por causa de 3 consumers em long-poll. A implementação FIFO dele é bem mais lenta que a do SQS real. Há também o custo por mensagem que escolhemos: um `DeleteMessage` por mensagem logo após o commit (ack individual, mais simples de raciocinar) e o processamento sequencial dentro de cada `MessageGroupId`. Melhorias possíveis: `DeleteMessageBatch` e mais grupos por receive. Não foram feitas para não complicar a semântica de ack-após-commit.

**Latência base.** Uma BET sequencial e sem contenção leva ≈ 20–25 ms ponta a ponta. São ~10 round-trips ao Postgres (`set_config`, `FOR UPDATE`, idempotência, insert da transação, update da wallet, insert do ledger com o trigger de encadeamento, nudge, outbox) mais o constraint trigger diferido no COMMIT. É o preço consciente de fazer as invariantes no schema (ARCHITECTURE.md, trade-off 3).

### Limitações do experimento (honestidade)
- **Tudo no mesmo notebook** (Ryzen 7 5700U, 16 threads, Windows 11 + Docker Desktop/WSL2): gerador de carga, 3 apps, Postgres e LocalStack disputam a mesma CPU, e o port-forwarding do Docker Desktop adiciona latência. Os números valem como comparação relativa (antes/depois, quente/frio), não como capacidade de produção.
- **Variância entre execuções** de ±10–15% (por exemplo, A entre 132 e 156 req/s em duas execuções idênticas). Executamos poucas vezes, sem intervalo de confiança.
- Percentis de histograma (espera de lock, lag de publicação) são o **limite superior do bucket**, não valores exatos.
- O LocalStack não reproduz latência nem throughput do SQS real.
- Sem warm-up dedicado (os primeiros segundos incluem JIT/conexões frias) e sem *open-loop*, o que suaviza o efeito de "coordinated omission" na cauda.
<!-- ANALYSIS:END -->
