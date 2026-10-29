# Glossário

Termos, siglas e expressões usados neste repositório (código, `README.md`, `ARCHITECTURE.md`, `docs/DESIGN.md`, `docs/LOAD_TEST.md`, `docs/CHALLENGE.md`) que não são de uso comum. Cada verbete diz **o que é** e, quando relevante, **como aparece neste projeto**.

Organização: seções temáticas e, dentro de cada uma, ordem alfabética.

- [1. Domínio de apostas (iGaming)](#1-domínio-de-apostas-igaming)
- [2. Finanças e contabilidade](#2-finanças-e-contabilidade)
- [3. Arquitetura e modelagem (DDD / hexagonal)](#3-arquitetura-e-modelagem-ddd--hexagonal)
- [4. Banco de dados e PostgreSQL](#4-banco-de-dados-e-postgresql)
- [5. Concorrência e consistência](#5-concorrência-e-consistência)
- [6. Idempotência e deduplicação](#6-idempotência-e-deduplicação)
- [7. Mensageria (SQS, inbox, outbox)](#7-mensageria-sqs-inbox-outbox)
- [8. HTTP e API](#8-http-e-api)
- [9. Autenticação e segurança](#9-autenticação-e-segurança)
- [10. Observabilidade](#10-observabilidade)
- [11. Testes e teste de carga](#11-testes-e-teste-de-carga)
- [12. Ferramentas, stack e infraestrutura](#12-ferramentas-stack-e-infraestrutura)
- [13. Códigos de falha e de erro do projeto](#13-códigos-de-falha-e-de-erro-do-projeto)

---

## 1. Domínio de apostas (iGaming)

**BET** — Aposta. Debita o valor apostado da wallet. É rejeitada com `INSUFFICIENT_FUNDS` se o saldo não cobrir o valor.

**gameId** — Identificador do jogo no provedor (ex.: `fortune-chimp`). Informativo; não participa das regras de saldo.

**iGaming** — Jogos de azar online (cassino, slots, apostas). É o segmento da Jungle Gaming.

**LOSS** — Resultado de rodada perdida. Fica registrado, mas **não move saldo** e não gera lançamento no ledger (o valor já foi debitado na BET).

**OPENING** — Tipo **interno** de transação: o crédito do saldo inicial quando uma wallet é criada com saldo maior que zero. Não pode ser enviado por API nem pela fila.

**Player (`playerId`)** — Jogador dono da wallet. Existe no máximo uma wallet por `playerId` + moeda.

**Provedor (provider, `providerId`)** — Empresa/estúdio de jogos que envia as operações de aposta para o sistema (ex.: `provider-a`).

**REFUND** — Estorno de uma BET (ex.: rodada cancelada). Credita de volta o mesmo valor. Só pode referenciar uma BET `PROCESSED` e só pode acontecer uma vez.

**ROLLBACK** — Reversão de uma transação já processada (BET, WIN ou REFUND), aplicando o efeito **inverso**: ROLLBACK de BET credita; ROLLBACK de WIN ou REFUND debita.

**Rodada (round, `roundId`)** — Uma jogada/partida. Agrupa a BET e seu desfecho (WIN, LOSS, REFUND ou ROLLBACK). Referências têm que pertencer à mesma rodada.

**Wallet** — Carteira de saldo de um jogador numa moeda. É o *aggregate root* do domínio e a unidade de concorrência.

**WIN** — Prêmio. Credita o valor na wallet; pode, opcionalmente, referenciar a BET da mesma rodada.

---

## 2. Finanças e contabilidade

**Double-entry bookkeeping (partidas dobradas)** — Método contábil em que todo movimento gera dois lançamentos (débito numa conta, crédito em outra) que se anulam. Era diferencial opcional e **não** foi implementado: aqui o ledger é *single-entry* por wallet.

**Hot wallet** — Wallet "quente": recebe uma fração desproporcional do tráfego. Como as operações de uma wallet são serializadas, ela limita a vazão e é o pior caso dos testes de carga. (Não confundir com o uso em cripto, onde significa carteira online.)

**ISO-4217** — Padrão internacional de códigos de moeda com 3 letras (`BRL`, `USD`, `EUR`). Validado pela regex `^[A-Z]{3}$`.

**Ledger (livro-razão)** — Registro **append-only** de todos os lançamentos (`wallet_ledger_entries`). Cada linha guarda direção, valor, `balanceBefore` e `balanceAfter`. Nunca é alterado nem apagado; o saldo da wallet tem que ser sempre reconstruível a partir dele.

**Lançamento (ledger entry)** — Uma linha do ledger (`WalletLedgerEntry`). Cada transação que altera saldo produz exatamente um lançamento.

**`LedgerDirection` (DEBIT / CREDIT)** — Direção do lançamento: `DEBIT` diminui o saldo, `CREDIT` aumenta.

**Money** — Objeto de valor imutável que representa uma quantia monetária exata: um `Decimal` com 2 casas e uma moeda. Nunca usa `number`/`float`.

**`MoneyProps`** — Forma serializada de `Money`: `{ "amount": "25.00", "currency": "BRL" }`, com o valor como **string decimal**. É o que trafega em HTTP, SQS e eventos.

**`NUMERIC(20,2)`** — Tipo decimal **exato** do PostgreSQL: até 20 dígitos, 2 deles depois da vírgula. Usado para valores e saldos.

**Reconciliação** — Conferência entre o saldo armazenado na wallet e o saldo recalculado a partir do ledger. Divergências são logadas, contadas em métrica e sinalizadas na resposta; **nunca** corrigidas automaticamente.

**Saldo materializado** — O saldo guardado diretamente na linha da wallet (`wallets.balance`), em vez de ser calculado somando o ledger a cada leitura. O sistema garante que os dois batem.

**Single-entry** — Ledger com um único lançamento por movimento, na conta afetada (a wallet). É o modelo adotado.

---

## 3. Arquitetura e modelagem (DDD / hexagonal)

**Adapter (adaptador)** — Implementação concreta de uma porta (ex.: repositório MikroORM, publisher SQS, `JwksProviderIdentity`). Fica em `src/infrastructure`.

**Aggregate / Aggregate Root** — Em DDD, um conjunto de objetos tratado como unidade de consistência, acessado por um objeto "raiz". Aqui `Wallet` é a raiz: o saldo só muda via `Wallet.debit/credit`.

**Bootstrap** — Camada que monta a aplicação: configuração, injeção de dependências e inicialização (`src/bootstrap`).

**Boundary (fronteira)** — Limite entre camadas ou módulos. Define o que pode depender de quê.

**Composition root** — Único ponto onde as implementações concretas são ligadas às interfaces (aqui, os módulos Nest em `bootstrap`/`infrastructure`).

**DDD (Domain-Driven Design)** — Abordagem que põe o modelo de negócio no centro do código: entidades, objetos de valor, agregados e linguagem ubíqua.

**DTO (Data Transfer Object)** — Estrutura de dados sem comportamento, usada para transportar dados entre camadas ou pela rede (ex.: corpo do `POST /wagering/transactions`).

**Entity (entidade)** — Objeto de domínio com identidade própria que persiste ao longo do tempo (ex.: `WagerTransaction`).

**`EntitySchema`** — Forma do MikroORM de mapear tabelas **sem decorators**, num arquivo separado. Mantém o domínio livre do ORM.

**Factory estática** — Método estático que cria instâncias (`create`, `open`, `from`, `rehydrate`). Junto com o construtor `private`, garante que nenhum objeto nasça inválido.

**Hexagonal (Ports & Adapters)** — Arquitetura em que o núcleo (domínio + aplicação) define **portas** (interfaces) e o mundo externo (HTTP, banco, fila) se conecta por **adaptadores**. Permite trocar a infraestrutura sem mexer nas regras.

**Identity Map** — Padrão de ORM que mantém uma única instância em memória por linha do banco dentro de uma sessão. O projeto o desabilita nas leituras críticas, para sempre ler o estado do banco.

**Integration Event (evento de integração)** — Mensagem publicada para **outros sistemas** quando algo relevante acontece (ex.: `WalletBalanceChanged`). Aqui é a classe abstrata `IntegrationEvent<T>`, com uma subclasse por evento.

**Invariante** — Regra que tem que valer **sempre** (ex.: saldo ≥ 0; saldo = ledger). É garantida no domínio e, como última defesa, no schema do banco.

**Mapper** — Código que converte entre o *record* de persistência (linha do banco) e o objeto de domínio (`mappers.ts`).

**Port (porta)** — Interface que a camada de aplicação define e a infraestrutura implementa (ex.: `UnitOfWork`, `ProviderIdentityPort`, `Clock`).

**Record** — Objeto plano que espelha uma linha de tabela, usado pelo ORM. Separado da classe de domínio.

**`rehydrate`** — Factory que **reconstrói** um objeto a partir de dados já persistidos, **sem** revalidar regras de transição (o estado já foi validado ao ser gravado).

**Use case (caso de uso)** — Classe da camada de aplicação que orquestra uma operação de negócio (ex.: `ProcessWagerTransaction`). O mesmo use case atende HTTP e SQS.

**Value Object (objeto de valor)** — Objeto definido pelo valor, não por identidade, e imutável (ex.: `Money`).

**`WagerEvaluator` / `WagerPolicy`** — Componentes do projeto que concentram as regras de BET/WIN/LOSS/REFUND/ROLLBACK e decidem o resultado (aplicar, rejeitar, aguardar referência). São reaproveitados pela submissão e pelo worker de pendências.

---

## 4. Banco de dados e PostgreSQL

**Append-only** — Tabela que só aceita INSERT; UPDATE, DELETE e TRUNCATE são bloqueados por trigger (caso do ledger).

**CHECK constraint** — Regra declarada na tabela que o banco valida em toda escrita (ex.: `balance >= 0`).

**Constraint trigger diferido (`DEFERRABLE INITIALLY DEFERRED`)** — Trigger que só roda no **COMMIT**, não a cada comando. O `wallets_ledger_backed` usa isso para checar, no fim da transação, que o saldo da wallet bate com o último lançamento.

**FK composta** — Chave estrangeira com mais de uma coluna, ex.: `(wallet_id, currency)`. Garante que o lançamento está na mesma moeda da wallet.

**Índice único parcial** — Índice `UNIQUE` aplicado só às linhas que satisfazem um `WHERE`. O `wager_tx_single_reversal_uk` impede que a mesma referência seja revertida duas vezes.

**`lock_timeout`** — Tempo máximo que um comando espera por um lock antes de falhar (`55P03`). Configurado em 5 s por transação.

**Migration** — Script versionado que altera o schema. Aqui são SQL escritos à mão, com `up` (aplicar) e `down` (reverter).

**`ON CONFLICT DO NOTHING`** — Cláusula de INSERT do Postgres que ignora a inserção se ela violar uma constraint única, sem lançar erro. Usada no inbox e na detecção de corrida de idempotência.

**`READ COMMITTED`** — Nível de isolamento padrão do Postgres: cada comando enxerga o que já foi commitado antes dele. É o nível usado nas transações de negócio.

**`REPEATABLE READ`** — Nível de isolamento em que toda a transação enxerga o mesmo *snapshot*. Usado na reconciliação, para ler saldo e ledger consistentes sem bloquear quem escreve.

**`SERIALIZABLE`** — Nível de isolamento mais forte; aborta transações que poderiam gerar anomalias. Não foi usado (ver `ARCHITECTURE.md` §5).

**`session_replication_role = replica`** — Configuração do Postgres que desativa triggers na sessão. Usada **só em teste**, para forçar uma divergência e provar que a reconciliação a detecta.

**SQLSTATE** — Código padronizado de 5 caracteres dos erros SQL. Os relevantes aqui:
- `23505`: violação de unicidade;
- `40001`: falha de serialização;
- `40P01`: deadlock;
- `55P03`: `lock_timeout`;
- `57014`: comando cancelado (ex.: `statement_timeout`).

O projeto classifica erros como transitórios ou permanentes por esse código.

**`statement_timeout`** — Tempo máximo de execução de um comando SQL (15 s por transação).

**Trigger** — Função que o banco executa automaticamente antes ou depois de uma escrita. Aqui impõe imutabilidade do ledger, encadeamento de versões e estados terminais.

**`TRUNCATE`** — Comando que esvazia uma tabela de uma vez. Bloqueado no ledger.

---

## 5. Concorrência e consistência

**At-least-once** — Garantia de entrega "pelo menos uma vez": nada se perde, mas pode chegar duplicado. Por isso o consumidor precisa ser idempotente.

**Atomicidade** — Propriedade de "tudo ou nada": transação, saldo, ledger, inbox e outbox são confirmados juntos ou nenhum é.

**Backoff exponencial** — Estratégia de retry em que a espera dobra a cada tentativa (ex.: 1 s, 2 s, 4 s...), normalmente com um teto.

**Claim** — "Reservar" um lote de linhas para processar (outbox, pendências) de modo que outras instâncias não peguem as mesmas.

**Clock skew** — Diferença entre os relógios de máquinas diferentes. Relevante porque alguns horários de retry são calculados na aplicação.

**Deadlock** — Duas transações esperando uma pela outra para sempre. O Postgres detecta e aborta uma delas (`40P01`). Evitado aqui travando sempre uma única wallet, em ordem fixa.

**`FOR UPDATE`** — Cláusula de SELECT que trava as linhas lidas até o fim da transação. É o **lock pessimista** da wallet.

**Head-of-line blocking** — Quando a primeira mensagem de uma fila ordenada trava as seguintes enquanto não for resolvida (ex.: SQS FIFO, mesmo grupo).

**Jitter** — Aleatoriedade somada ao tempo de backoff para que vários clientes não tentem de novo exatamente ao mesmo tempo.

**`KeyedSerializer`** — Componente do projeto: fila FIFO **em memória**, por wallet, dentro de cada instância. Evita que muitas requisições da mesma wallet ocupem conexões do pool esperando o lock. É só otimização: a garantia entre instâncias continua sendo o `FOR UPDATE`.

**Lease** — "Aluguel" temporário de um item reservado (aqui, 30 s). Se a instância morrer, o lease expira e outra pode assumir.

**Load shedding** — Recusar trabalho de propósito (ex.: 503) quando o sistema está saturado, para não degradar tudo.

**Lock otimista (optimistic locking)** — Não trava; grava com `WHERE version = ?` e, se outro escreveu antes, falha e tenta de novo. Ruim para hot wallets.

**Lock pessimista (pessimistic locking)** — Trava a linha antes de ler e decidir (`FOR UPDATE`). É a estratégia escolhida.

**Lost update** — Anomalia em que duas transações leem o mesmo valor, calculam e gravam, e uma sobrescreve a outra. É o que "`read → calculate → update` sem controle" causa.

**Nudge ("cutucada")** — Quando uma transação é processada, o sistema antecipa (`next_reference_check_at = now()`) a próxima checagem das pendências que dependem dela. Otimização; a garantia é o agendamento.

**Race condition (condição de corrida)** — Bug em que o resultado depende da ordem/tempo de execução de operações concorrentes.

**`SKIP LOCKED`** — Com `FOR UPDATE`, pula as linhas já travadas por outra transação em vez de esperar. Permite que vários workers peguem lotes **disjuntos** da mesma tabela.

**`version`** — Contador da wallet: começa em 1 e sobe 1 a cada mudança de saldo. Serve de defesa contra lost update e de número de sequência dos lançamentos.

---

## 6. Idempotência e deduplicação

**Canonical JSON (JSON canônico)** — Serialização determinística de JSON: chaves ordenadas, sem espaços. O mesmo conteúdo sempre gera a mesma string e, portanto, o mesmo hash.

**Deduplicação (dedup)** — Detectar e descartar o processamento repetido de uma mesma mensagem ou requisição.

**Idempotência** — Propriedade de uma operação que, repetida várias vezes, produz o mesmo efeito que uma única vez.

**`Idempotency-Key`** — Header HTTP obrigatório que identifica a operação (padrão `"{providerId}:{externalTransactionId}"`). É a fonte da verdade para detectar repetições.

**`idempotentReplay`** — Campo da resposta: `true` quando a requisição é uma repetição e o sistema devolveu o resultado original, sem reprocessar.

**`IdempotencyRaceError`** — Erro interno do projeto: duas requisições com a mesma key chegaram juntas por caminhos que não se bloquearam. A transação é desfeita e repetida; na segunda vez vira replay ou conflito.

**`payloadHash`** — SHA-256 do JSON canônico dos 9 campos de negócio da transação. Mesma key com hash diferente = conflito (409), não replay.

**Replay** — Devolver o resultado gravado de uma operação já processada, incluindo o saldo observado naquele momento.

**SHA-256** — Função de hash criptográfico que produz 256 bits (64 caracteres hex). Usada no `payloadHash`.

---

## 7. Mensageria (SQS, inbox, outbox)

**Ack (acknowledge)** — Confirmar ao broker que a mensagem foi processada; no SQS é o `DeleteMessage`. Aqui só acontece **depois do commit**.

**Broker** — Servidor de mensageria que recebe, guarda e entrega mensagens (aqui, SQS).

**`causationId`** — Id da mensagem/evento que **causou** este evento. Permite rastrear a cadeia de causas.

**`ChangeMessageVisibility`** — Chamada do SQS que altera por quanto tempo a mensagem fica invisível. Usada para fazer retry com backoff (ou devolvê-la imediatamente com 0).

**`correlationId`** — Id que acompanha uma operação de ponta a ponta (HTTP → banco → eventos → logs), para correlacionar tudo que pertence a ela. Vem do header `X-Correlation-Id` ou é gerado.

**DLQ (Dead-Letter Queue)** — Fila para onde vão mensagens que não puderam ser processadas (`wager-transactions-dlq.fifo`): inválidas (*poison*) ou que esgotaram as tentativas.

**Envelope** — Estrutura padrão que embrulha os dados de um evento com metadados (`eventId`, `eventType`, `version`, `occurredAt`, `correlationId`...).

**`eventId`** — Identificador único de um evento. Consumidores usam para deduplicar publicações repetidas.

**FIFO queue (`.fifo`)** — Fila SQS que preserva ordem dentro de um grupo e deduplica por um período. Aqui é **otimização**, não garantia.

**Graceful shutdown** — Desligamento ordenado: parar de aceitar trabalho, terminar ou devolver o que está em andamento e fechar conexões.

**Inbox (transactional inbox)** — Tabela `inbox_messages` que registra cada `messageId` recebido, por `(consumerName, messageId)`, na mesma transação do efeito. Uma mensagem repetida é detectada e só recebe ack.

**Long polling** — Pedido ao SQS que fica aberto até chegar mensagem (ou dar o tempo limite), em vez de consultar repetidamente.

**`maxReceiveCount`** — Número de vezes que o SQS entrega uma mensagem antes de movê-la para a DLQ (aqui, 5).

**`MessageDeduplicationId`** — Id que o SQS FIFO usa para descartar envios duplicados numa janela de 5 minutos.

**`MessageGroupId`** — Chave de ordenação do SQS FIFO: mensagens do mesmo grupo são entregues em ordem. Aqui o grupo é o `walletId`.

**`messageId`** — Identificador da mensagem de entrada, usado na deduplicação pelo inbox.

**Outbox (transactional outbox)** — Padrão em que o evento é **gravado numa tabela** (`outbox_messages`) na mesma transação do efeito, e um worker o publica depois. Garante que não se publica nada antes do commit e que nada confirmado se perde.

**Outbox lag** — Atraso entre gravar o evento no outbox e publicá-lo. Métrica `wagering_outbox_oldest_pending_age_seconds`.

**`PENDING_REFERENCE`** — Status da transação cuja referência (ex.: a BET de um REFUND) ainda não chegou. Um worker tenta resolvê-la depois.

**Poison message** — Mensagem que nunca vai ser processada com sucesso (JSON ou schema inválido). Vai direto para a DLQ, sem retries inúteis.

**Publisher** — Worker que lê o outbox e publica os eventos no SQS (`wallet-events.fifo`).

**Redelivery** — Reentrega de uma mensagem pelo broker (porque não houve ack a tempo, por exemplo).

**Redrive policy** — Configuração da fila SQS que move mensagens para a DLQ depois de `maxReceiveCount` entregas.

**SQS (Simple Queue Service)** — Serviço de filas da AWS. Aqui é emulado localmente pelo LocalStack.

**Visibility timeout** — Tempo em que uma mensagem recebida fica invisível para os outros consumidores. Se não houver ack nesse prazo, ela volta para a fila.

**Worker** — Processo/laço em segundo plano que executa uma tarefa recorrente (consumer SQS, outbox publisher, worker de pendências).

---

## 8. HTTP e API

**Cursor (paginação por cursor)** — Paginação que devolve um token **opaco** apontando para "depois do último item visto", em vez de `page`/`offset`. É estável mesmo com inserções novas. Usado em `/wallets/:id/ledger`.

**Endpoint** — Rota da API (método + caminho), ex.: `POST /wagering/transactions`.

**Health check** — Endpoint de saúde:
- `/health/live` (**liveness**) diz se o processo está vivo;
- `/health/ready` (**readiness**) diz se ele pode atender, com Postgres e SQS alcançáveis.

**Opaco (opaque)** — Valor cujo formato interno o cliente não deve interpretar nem montar; só devolver como recebeu (ex.: o cursor em base64).

**`Retry-After`** — Header HTTP que diz ao cliente quanto esperar antes de tentar de novo (enviado com o 503).

**`retryable`** — Campo da resposta de erro que diz se **reenviar a mesma requisição** pode dar resultado diferente. Só é `true` em falha transitória (503).

**Status HTTP usados** — 200 OK, 201 Created, 202 Accepted (aceito, processamento pendente), 400 Bad Request (payload inválido), 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict (idempotência / duplicidade), 422 Unprocessable Entity (rejeição de regra de negócio), 500 Internal Error, 503 Service Unavailable (falha transitória).

**Transiente / transitório** — Falha temporária que pode passar se tentar de novo (lock timeout, banco reiniciando). Oposto de **permanente**.

---

## 9. Autenticação e segurança

**Audience (`aud`)** — Claim do JWT que diz para qual API o token foi emitido (aqui, `wagering-api`).

**Claim** — Campo dentro de um JWT (ex.: `iss`, `exp`, `aud`, `provider_id`).

**Client credentials** — Fluxo OAuth 2.0 de **máquina a máquina**: o provedor se autentica com `client_id` + `client_secret` e recebe um token, sem usuário humano.

**Guard** — Componente NestJS que decide se uma requisição pode prosseguir (aqui, o guard de autenticação JWT).

**IdP (Identity Provider)** — Serviço externo que autentica e emite tokens (aqui, Keycloak).

**Issuer (`iss`)** — Claim do JWT que identifica quem emitiu o token.

**JWKS (JSON Web Key Set)** — Endpoint do IdP que publica as chaves públicas usadas para verificar a assinatura dos tokens.

**JWT (JSON Web Token)** — Token assinado em formato JSON (header.payload.assinatura), usado para autenticação.

**Keycloak** — IdP open source com OIDC completo. Sobe no profile `auth` do Docker Compose.

**No-op** — "Não faz nada". Com `AUTH_ENABLED=false`, o adaptador `DisabledProviderIdentity` aceita tudo, mantendo o ponto de extensão explícito.

**OIDC (OpenID Connect)** — Protocolo de identidade em cima do OAuth 2.0.

**`ProviderIdentityPort`** — Porta do projeto que abstrai "quem é o provedor desta requisição". Tem uma implementação desligada e uma via JWKS.

**Realm** — No Keycloak, um espaço isolado de usuários, clients e configurações (aqui, `wagering`).

**Redaction** — Mascarar ou remover campos sensíveis dos logs (tokens, payloads, valores monetários).

---

## 10. Observabilidade

**Child logger** — Logger derivado que já carrega campos fixos de contexto (ex.: `messageId`, `walletId`) em todas as linhas.

**Gauge / Counter / Histogram** — Tipos de métrica do Prometheus:
- **Counter** só cresce (ex.: total de transações);
- **Gauge** sobe e desce (ex.: profundidade da fila);
- **Histogram** distribui valores em faixas (ex.: latência), permitindo calcular percentis.

**Log estruturado** — Log em formato JSON com campos nomeados, em vez de texto livre. Facilita busca e agregação.

**Métrica** — Medida numérica exposta em `GET /metrics` (prefixo `wagering_`) para monitoramento.

**OpenTelemetry (OTel)** — Padrão aberto de traces, métricas e logs. Era opcional e não foi usado.

**pino** — Biblioteca de log JSON de alta performance para Node/Bun.

**Prometheus / prom-client** — Prometheus é o sistema de métricas que coleta (*scrape*) o endpoint `/metrics`; `prom-client` é a biblioteca que expõe as métricas nesse formato.

**Scrape** — A coleta periódica que o Prometheus faz no `/metrics`.

---

## 11. Testes e teste de carga

**Closed-loop** — Modelo de teste de carga em que cada trabalhador virtual só envia a próxima requisição depois de receber a resposta da anterior. A vazão se ajusta à latência.

**Determinismo** — Um teste dá sempre o mesmo resultado, sem depender de sorte de timing (sem `sleep` fixo; usa `waitFor` com polling).

**Fake** — Implementação simplificada em memória de uma porta, usada **só** nos testes de unidade.

**Fault injection (injeção de falha)** — Provocar uma falha de propósito num ponto exato (ex.: `process.exit(137)` logo depois do commit e antes do ack), para provar a recuperação.

**Flaky** — Teste instável, que às vezes passa e às vezes falha sem mudança de código.

**Mock** — Objeto falso que simula uma dependência. Proibido substituir Postgres e SQS por mocks nos testes de integração e concorrência.

**p50 / p95 / p99 (percentis)** — Latência abaixo da qual ficam 50%, 95% e 99% das requisições. O p50 é a mediana; p95 e p99 mostram a "cauda" lenta.

**PRNG semeado (seeded PRNG)** — Gerador de números pseudoaleatórios com semente fixa: a "aleatoriedade" se repete igual a cada execução, o que torna a carga reproduzível.

**Teste de carga (load test)** — Experimento que mede vazão, latência e erros sob volume alto (`bun run test:load`, relatório em `docs/LOAD_TEST.md`).

**Teste de concorrência** — Teste com **paralelismo real** (vários processos, requisições simultâneas) para provar que não há races.

**Teste de integração** — Teste que exercita a aplicação contra infraestrutura real (Postgres e LocalStack em containers).

**Teste de unidade** — Teste isolado de uma classe/função, sem I/O.

**Throughput (vazão)** — Quantidade de operações concluídas por unidade de tempo (req/s, msg/s).

**`waitFor`** — Utilitário de teste que espera uma condição ficar verdadeira por polling, com prazo, em vez de dormir um tempo fixo.

---

## 12. Ferramentas, stack e infraestrutura

**Bun** — Runtime JavaScript/TypeScript rápido que também é gerenciador de pacotes e test runner (`bun test`).

**Container** — Processo isolado empacotado com suas dependências (Docker).

**`decimal.js`** — Biblioteca de aritmética decimal de precisão arbitrária. É a base do `Money`.

**Decorator** — Sintaxe `@Algo()` do TypeScript para anotar classes e métodos (muito usada no NestJS). O domínio não usa decorators.

**Docker Compose** — Ferramenta que sobe vários containers (Postgres, LocalStack, app ×3, Keycloak) a partir de `docker-compose.yml`.

**ESM (ECMAScript Modules)** — Sistema de módulos padrão do JavaScript (`import`/`export`). NestJS 12 e MikroORM 7 são ESM-only.

**`jose`** — Biblioteca para validar JWT/JWKS.

**LocalStack** — Emulador local de serviços AWS (aqui, SQS) que roda em Docker.

**MikroORM** — ORM TypeScript com Unit of Work e Identity Map explícitos. Foi o ORM escolhido.

**MiniStack** — Alternativa mais leve ao LocalStack citada no desafio (não usada).

**NestJS** — Framework Node/TypeScript para backends modulares, com injeção de dependências.

**ORM (Object-Relational Mapper)** — Biblioteca que mapeia objetos do código para tabelas do banco.

**Profile (Compose)** — Grupo opcional de serviços do Docker Compose, ativado com `--profile` (ex.: `auth` sobe o Keycloak).

**Pool de conexões** — Conjunto de conexões ao banco reutilizadas entre requisições. Esgotá-lo trava a aplicação; daí o `KeyedSerializer`.

**SIGTERM / SIGKILL** — Sinais de término de processo no Unix:
- **SIGTERM** pede um desligamento educado, que dispara o graceful shutdown;
- **SIGKILL** mata o processo na hora, sem chance de limpeza;
- o código de saída **137** corresponde a morte por SIGKILL.

**Strict mode (TypeScript)** — Conjunto de verificações rígidas do compilador (`strict: true`).

**`useFactory` / `@Inject(TOKEN)`** — Recursos do NestJS para criar providers por função e injetá-los por um token explícito. Permitem que os use cases sejam classes puras, sem decorators.

**UUIDv7** — Formato de UUID ordenável por tempo: os primeiros bits são um timestamp. Melhora a localidade em índices.

**zod** — Biblioteca de validação de schemas; um mesmo schema valida a entrada HTTP e a SQS.

---

## 13. Códigos de falha e de erro do projeto

Códigos estáveis, legíveis por máquina. Detalhes e ação esperada do provedor estão em `ARCHITECTURE.md` §9.

**Status de `WagerTransaction`**
- `PENDING`: aceita, ainda não aplicada (existe só em memória durante a decisão).
- `PENDING_REFERENCE`: aguardando a transação referenciada.
- `PROCESSED`: aplicada. Terminal.
- `REJECTED`: violou regra de negócio. Terminal.
- `FAILED`: erro permanente inesperado. Terminal e auditável.

**Estado terminal** — Status final (`PROCESSED`, `REJECTED`, `FAILED`): não muda mais. Tentar transicioná-lo é erro de programação (`InvalidTransactionStateError`), e o banco também impede (trigger `wager_tx_guard`).

**`failureCode` (transação persistida)**
- `INSUFFICIENT_FUNDS`: BET maior que o saldo.
- `REVERSAL_INSUFFICIENT_FUNDS`: a reversão deixaria o saldo negativo (distinto do anterior por ser outra situação operacional).
- `CURRENCY_MISMATCH`: moeda diferente da wallet.
- `WALLET_PLAYER_MISMATCH`: a wallet não pertence ao `playerId`.
- `REFERENCE_NOT_FOUND`: a referência não chegou dentro da janela de retries.
- `REFERENCE_MISMATCH`: a referência é de outra wallet, player, moeda ou rodada.
- `INVALID_REFERENCE_KIND`: tipo de referência incompatível (ex.: REFUND de um WIN).
- `REFERENCE_NOT_PROCESSED`: a referência foi rejeitada ou falhou.
- `ALREADY_REVERSED`: a referência já foi revertida.
- `AMOUNT_MISMATCH`: o valor da reversão difere do valor da referência.
- `PROCESSING_ERROR`: erro permanente inesperado no worker (status `FAILED`).

**Códigos de erro HTTP (`error.code`)**
- `VALIDATION_ERROR`: payload inválido (400).
- `IDEMPOTENCY_KEY_REQUIRED`: header `Idempotency-Key` ausente ou inválido (400).
- `INVALID_CURSOR`: cursor de paginação inválido (400).
- `UNAUTHORIZED` (401) e `FORBIDDEN` (403): autenticação e autorização.
- `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND`: recurso inexistente (404; `WALLET_NOT_FOUND` vira 422 na submissão de transação).
- `WALLET_ALREADY_EXISTS`: wallet duplicada para o mesmo player + moeda (409).
- `IDEMPOTENCY_CONFLICT`: mesma key com payload diferente (409). Variantes de detalhe:
  - `PAYLOAD_MISMATCH`: mesma key, hash diferente;
  - `EXTERNAL_ID_BOUND_TO_OTHER_KEY`: o `externalTransactionId` já está ligado a outra key;
  - `KEY_AND_EXTERNAL_ID_MISMATCH`: a key e o externalId apontam para transações diferentes.
- `TRANSIENT_FAILURE`: falha transitória depois dos retries internos (503, `retryable: true`).
- `INTERNAL_ERROR`: erro inesperado (500, sem detalhes internos).

**Outros códigos internos**
- `DUPLICATE_MESSAGE`: mensagem SQS já registrada no inbox. Recebe ack sem efeito.
- `BALANCE_DIFFERS_FROM_LEDGER_SUM`, `LAST_ENTRY_MISMATCH`, `LEDGER_CHAIN_BROKEN`: tipos de divergência apontados pela reconciliação.
