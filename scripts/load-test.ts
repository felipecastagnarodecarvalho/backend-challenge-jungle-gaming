/**
 * Load test against the compose stack (app-1..3 on 3001-3003).
 *
 *   docker compose up -d --build && bun run test:load
 *
 * Scenarios: A) HTTP closed loop with mixed operations and a hot wallet;
 * B) single hot wallet (cost of the per-wallet pessimistic lock);
 * C) SQS throughput (time to drain N messages).
 * Collects latency percentiles, error classes, metric deltas from all
 * instances (lock conflicts, retries, duplicates, lock wait, outbox lag),
 * reconciles every wallet afterwards and writes docs/LOAD_TEST.md.
 * The "Análise" block of an existing report is preserved between runs.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';

// ---------------------------------------------------------------- parameters
const env = process.env;
const P = {
  durationS: Number(env.LOAD_DURATION_S ?? 60),
  hotDurationS: Number(env.LOAD_HOT_DURATION_S ?? 30),
  concurrency: Number(env.LOAD_CONCURRENCY ?? 64),
  wallets: Number(env.LOAD_WALLETS ?? 200),
  hotShare: Number(env.LOAD_HOT_WALLET_SHARE ?? 0.1),
  sqsMessages: Number(env.LOAD_SQS_MESSAGES ?? 5000),
  targets: (env.LOAD_TARGETS ?? 'http://127.0.0.1:3001,http://127.0.0.1:3002,http://127.0.0.1:3003').split(','),
  databaseUrl: env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
  sqsEndpoint: env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  queueName: env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
};
const RUN = Date.now().toString(36);
const PROVIDER = `load-${RUN}`;
const ROOT = join(import.meta.dir, '..');

// ---------------------------------------------------------------- helpers
let rr = 0;
const target = () => P.targets[rr++ % P.targets.length] as string;
const uuid = () => crypto.randomUUID();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
}
const ms = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a');

type Outcome = 'ok' | 'replay' | 'pending' | 'business' | 'conflict' | 'client' | 'server' | 'network';
interface Sample {
  latencyMs: number;
  outcome: Outcome;
  status: number;
  failureCode?: string;
  hot: boolean;
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${target()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function classify(status: number, json: Record<string, unknown>): Outcome {
  if (status === 201) return 'ok';
  if (status === 200) return json.idempotentReplay ? 'replay' : 'ok';
  if (status === 202) return 'pending';
  if (status === 422) return 'business';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  return 'client';
}

// ---------------------------------------------------------------- metrics
async function scrapeAll(): Promise<string[]> {
  return Promise.all(P.targets.map(async (t) => (await fetch(`${t}/metrics`)).text()));
}
function sumSeries(texts: string[], name: string, filter: Record<string, string> = {}): number {
  let total = 0;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
      if (Object.entries(filter).every(([k, v]) => line.includes(`${k}="${v}"`)))
        total += Number(line.slice(line.lastIndexOf(' ') + 1));
    }
  }
  return total;
}
/** Cumulative bucket counts (summed across instances) for a histogram. */
function buckets(texts: string[], name: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.startsWith(`${name}_bucket{`)) continue;
      const le = /le="([^"]+)"/.exec(line)?.[1];
      if (!le) continue;
      const bound = le === '+Inf' ? Number.POSITIVE_INFINITY : Number(le);
      out.set(bound, (out.get(bound) ?? 0) + Number(line.slice(line.lastIndexOf(' ') + 1)));
    }
  }
  return out;
}
function histogramQuantile(before: Map<number, number>, after: Map<number, number>, q: number): string {
  const bounds = [...after.keys()].sort((a, b) => a - b);
  const total = (after.get(Number.POSITIVE_INFINITY) ?? 0) - (before.get(Number.POSITIVE_INFINITY) ?? 0);
  if (total <= 0) return 'n/a';
  for (const b of bounds) {
    const c = (after.get(b) ?? 0) - (before.get(b) ?? 0);
    if (c >= q * total) return b === Number.POSITIVE_INFINITY ? '> maior bucket' : `≤ ${b * 1000} ms`;
  }
  return 'n/a';
}

// ---------------------------------------------------------------- setup
interface Wallet {
  id: string;
  playerId: string;
}
async function createWallets(n: number): Promise<Wallet[]> {
  const out: Wallet[] = [];
  const chunk = 20;
  for (let i = 0; i < n; i += chunk) {
    const created = await Promise.all(
      Array.from({ length: Math.min(chunk, n - i) }, async () => {
        const playerId = uuid();
        const r = await post('/wallets', { playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } });
        if (r.status !== 201) throw new Error(`wallet creation failed: ${r.status} ${JSON.stringify(r.json)}`);
        return { id: r.json.id as string, playerId };
      }),
    );
    out.push(...created);
  }
  return out;
}

// ---------------------------------------------------------------- scenario runners
interface LastBet {
  wallet: Wallet;
  ext: string;
  round: string;
  amount: string;
  refunded: boolean;
}

async function closedLoop(
  wallets: Wallet[],
  hot: Wallet,
  hotShare: number,
  durationS: number,
): Promise<{ samples: Sample[]; elapsedS: number }> {
  const samples: Sample[] = [];
  const deadline = performance.now() + durationS * 1000;
  const started = performance.now();
  const worker = async (seed: number) => {
    let last: LastBet | undefined;
    let previous: { body: Record<string, unknown>; key: string } | undefined;
    let n = seed;
    while (performance.now() < deadline) {
      n++;
      let body: Record<string, unknown>;
      let key: string;
      if (previous && Math.random() < 0.02) {
        ({ body, key } = previous); // identical resend → replay
      } else {
        const wallet = Math.random() < hotShare ? hot : (wallets[Math.floor(Math.random() * wallets.length)] as Wallet);
        const ext = `${PROVIDER}-${seed}-${n}-${uuid().slice(0, 8)}`;
        const cents = 1 + Math.floor(Math.random() * 5000);
        const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
        const roll = Math.random();
        const base = {
          providerId: PROVIDER,
          externalTransactionId: ext,
          playerId: wallet.id === last?.wallet.id ? last.wallet.playerId : wallet.playerId,
          walletId: wallet.id,
          gameId: 'load-game',
        };
        if (roll < 0.7 || !last) {
          const round = `rd-${ext}`;
          body = { ...base, roundId: round, kind: 'BET', money: { amount, currency: 'BRL' } };
          last = { wallet, ext, round, amount, refunded: false };
        } else if (roll < 0.9) {
          body = {
            ...base,
            walletId: last.wallet.id,
            playerId: last.wallet.playerId,
            roundId: last.round,
            kind: 'WIN',
            money: { amount, currency: 'BRL' },
            referenceExternalTransactionId: last.ext,
          };
        } else if (roll < 0.95) {
          body = { ...base, roundId: `rd-${ext}`, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } };
        } else if (!last.refunded) {
          body = {
            ...base,
            walletId: last.wallet.id,
            playerId: last.wallet.playerId,
            roundId: last.round,
            kind: 'REFUND',
            money: { amount: last.amount, currency: 'BRL' },
            referenceExternalTransactionId: last.ext,
          };
          last.refunded = true;
        } else {
          body = { ...base, roundId: `rd-${ext}`, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } };
        }
        key = `${PROVIDER}:${ext}`;
        previous = { body, key };
      }
      const t0 = performance.now();
      try {
        const r = await post('/wagering/transactions', body, { 'Idempotency-Key': key });
        samples.push({
          latencyMs: performance.now() - t0,
          outcome: classify(r.status, r.json),
          status: r.status,
          failureCode: (r.json.failureCode as string) ?? undefined,
          hot: body.walletId === hot.id,
        });
      } catch {
        samples.push({
          latencyMs: performance.now() - t0,
          outcome: 'network',
          status: 0,
          hot: body.walletId === hot.id,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: P.concurrency }, (_, i) => worker(i * 1_000_000)));
  return { samples, elapsedS: (performance.now() - started) / 1000 };
}

function summarize(name: string, samples: Sample[], elapsedS: number) {
  const lat = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const count = (o: Outcome) => samples.filter((s) => s.outcome === o).length;
  const failureCodes = new Map<string, number>();
  for (const s of samples)
    if (s.failureCode) failureCodes.set(s.failureCode, (failureCodes.get(s.failureCode) ?? 0) + 1);
  return {
    name,
    requests: samples.length,
    elapsedS,
    rps: samples.length / elapsedS,
    p50: percentile(lat, 0.5),
    p95: percentile(lat, 0.95),
    p99: percentile(lat, 0.99),
    max: lat[lat.length - 1] ?? Number.NaN,
    ok: count('ok'),
    replay: count('replay'),
    pending: count('pending'),
    business: count('business'),
    conflict: count('conflict'),
    client: count('client'),
    server: count('server'),
    network: count('network'),
    errorRate: (count('server') + count('network')) / Math.max(1, samples.length),
    failureCodes: Object.fromEntries(failureCodes),
  };
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`load test run ${RUN}: ${JSON.stringify(P)}`);
  for (const t of P.targets) {
    const r = await fetch(`${t}/health/ready`);
    if (!r.ok) throw new Error(`${t} not ready (${r.status}) — run: docker compose up -d --build`);
  }
  const sql = new SQL(P.databaseUrl);
  const sqs = new SQSClient({
    region: 'us-east-1',
    endpoint: P.sqsEndpoint,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: P.queueName }))).QueueUrl as string;

  console.log(`creating ${P.wallets + 1} wallets…`);
  const wallets = await createWallets(P.wallets);
  const [hot] = await createWallets(1);
  if (!hot) throw new Error('hot wallet');

  // outbox lag sampler (1 s)
  const lagSamples: number[] = [];
  const pendingSamples: number[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const [text] = await Promise.all([fetch(`${P.targets[0]}/metrics`).then((r) => r.text())]);
        lagSamples.push(sumSeries([text], 'wagering_outbox_oldest_pending_age_seconds'));
        pendingSamples.push(sumSeries([text], 'wagering_outbox_pending_messages'));
      } catch {
        // ignore
      }
      await Bun.sleep(1000);
    }
  })();

  const m0 = await scrapeAll();
  console.log(`scenario A: closed loop, ${P.concurrency} workers, ${P.durationS}s, hot share ${P.hotShare}…`);
  const a = await closedLoop(wallets, hot, P.hotShare, P.durationS);
  const m1 = await scrapeAll();
  console.log(`scenario B: hot wallet only, ${P.hotDurationS}s…`);
  const b = await closedLoop([hot], hot, 1, P.hotDurationS);
  const m2 = await scrapeAll();

  console.log(`scenario C: ${P.sqsMessages} SQS messages…`);
  const sqsStart = performance.now();
  const sqsWallets = wallets.slice(0, Math.min(50, wallets.length));
  const entries = Array.from({ length: P.sqsMessages }, (_, i) => {
    const w = sqsWallets[i % sqsWallets.length] as Wallet;
    const ext = `${PROVIDER}-sqs-${i}`;
    const messageId = `${PROVIDER}-m-${i}`;
    return {
      Id: String(i % 10),
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: PROVIDER,
          externalTransactionId: ext,
          idempotencyKey: `${PROVIDER}:${ext}`,
          playerId: w.playerId,
          walletId: w.id,
          roundId: `rd-${ext}`,
          gameId: 'load-game',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        },
      }),
      MessageGroupId: w.id,
      MessageDeduplicationId: messageId,
    };
  });
  const batches: (typeof entries)[] = [];
  for (let i = 0; i < entries.length; i += 10) batches.push(entries.slice(i, i + 10));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++] as typeof entries;
        await sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: batch }));
      }
    }),
  );
  const sendS = (performance.now() - sqsStart) / 1000;
  for (;;) {
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    const left =
      Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    if (left === 0) break;
    await Bun.sleep(250);
  }
  const sqsDrainS = (performance.now() - sqsStart) / 1000;
  const [sqsCount] =
    await sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE provider_id = ${PROVIDER} AND source = 'SQS'`;
  const m3 = await scrapeAll();

  // wait for outbox to drain, then stop sampling
  const drainStart = performance.now();
  for (;;) {
    const [r] = await sql`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
    if ((r as { n: number }).n === 0 || performance.now() - drainStart > 60_000) break;
    await Bun.sleep(500);
  }
  const outboxDrainS = (performance.now() - drainStart) / 1000;
  sampling = false;
  await sampler;

  console.log('reconciling all wallets…');
  const allWallets = [...wallets, hot];
  const inconsistent: string[] = [];
  for (let i = 0; i < allWallets.length; i += 20) {
    const res = await Promise.all(allWallets.slice(i, i + 20).map((w) => post(`/wallets/${w.id}/reconciliation`, {})));
    res.forEach((r, j) => {
      if (r.json.consistent !== true) inconsistent.push((allWallets[i + j] as Wallet).id);
    });
  }
  const [bal] =
    await sql`SELECT COUNT(*)::int AS bad FROM wallets w WHERE w.id IN ${sql(allWallets.map((w) => w.id))} AND w.balance <>
                           COALESCE((SELECT SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) FROM wallet_ledger_entries e WHERE e.wallet_id = w.id), 0)`;
  await sql.close();
  sqs.destroy();

  // ------------------------------------------------------------ report
  const A = summarize('A — HTTP misto (closed loop)', a.samples, a.elapsedS);
  const Acold = summarize(
    'A — só wallets frias',
    a.samples.filter((s) => !s.hot),
    a.elapsedS,
  );
  const Ahot = summarize(
    'A — só hot wallet',
    a.samples.filter((s) => s.hot),
    a.elapsedS,
  );
  const B = summarize('B — hot wallet única', b.samples, b.elapsedS);
  const delta = (before: string[], after: string[], name: string, f: Record<string, string> = {}) =>
    sumSeries(after, name, f) - sumSeries(before, name, f);
  const lagSorted = [...lagSamples].sort((x, y) => x - y);
  const counters = (before: string[], after: string[]) => ({
    lockConflicts: delta(before, after, 'wagering_lock_conflicts_total'),
    lockTimeouts: delta(before, after, 'wagering_lock_conflicts_total', { reason: 'lock_timeout' }),
    deadlocks: delta(before, after, 'wagering_lock_conflicts_total', { reason: 'deadlock' }),
    retries: delta(before, after, 'wagering_processing_retries_total'),
    replays: delta(before, after, 'wagering_duplicates_total', { type: 'replay' }),
    conflicts: delta(before, after, 'wagering_duplicates_total', { type: 'conflict' }),
    inboxDup: delta(before, after, 'wagering_duplicates_total', { type: 'inbox' }),
    lockWaitP50: histogramQuantile(
      buckets(before, 'wagering_wallet_lock_wait_seconds'),
      buckets(after, 'wagering_wallet_lock_wait_seconds'),
      0.5,
    ),
    lockWaitP95: histogramQuantile(
      buckets(before, 'wagering_wallet_lock_wait_seconds'),
      buckets(after, 'wagering_wallet_lock_wait_seconds'),
      0.95,
    ),
    lockWaitP99: histogramQuantile(
      buckets(before, 'wagering_wallet_lock_wait_seconds'),
      buckets(after, 'wagering_wallet_lock_wait_seconds'),
      0.99,
    ),
    publishLagP50: histogramQuantile(
      buckets(before, 'wagering_outbox_publish_lag_seconds'),
      buckets(after, 'wagering_outbox_publish_lag_seconds'),
      0.5,
    ),
    publishLagP95: histogramQuantile(
      buckets(before, 'wagering_outbox_publish_lag_seconds'),
      buckets(after, 'wagering_outbox_publish_lag_seconds'),
      0.95,
    ),
    published: delta(before, after, 'wagering_outbox_published_total'),
  });
  const cA = counters(m0, m1);
  const cB = counters(m1, m2);
  const cC = counters(m2, m3);
  const sqsCommitted = (sqsCount as { n: number }).n;

  const run = (cmd: string) => {
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return 'n/a';
    }
  };
  const environment = {
    cpu: (os.cpus()[0]?.model ?? 'n/a').trim(),
    cpus: os.cpus().length,
    ramGb: (os.totalmem() / 1024 ** 3).toFixed(1),
    os: `${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
    bun: Bun.version,
    docker: run('docker version --format "{{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})"'),
    images: run('docker compose ps --format "{{.Image}}"')
      .split(/\r?\n/)
      .filter(Boolean)
      .sort()
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .join(', '),
  };
  const result = {
    run: RUN,
    params: P,
    environment,
    A,
    Acold,
    Ahot,
    B,
    cA,
    cB,
    cC,
    sqs: {
      messages: P.sqsMessages,
      committed: sqsCommitted,
      sendS,
      drainS: sqsDrainS,
      msgPerS: P.sqsMessages / sqsDrainS,
    },
    outbox: {
      lagMaxS: lagSorted[lagSorted.length - 1] ?? 0,
      lagP95S: percentile(lagSorted, 0.95),
      lagP50S: percentile(lagSorted, 0.5),
      pendingMax: Math.max(0, ...pendingSamples),
      drainAfterLoadS: outboxDrainS,
      samples: lagSamples.length,
    },
    reconciliation: {
      wallets: allWallets.length,
      inconsistent: inconsistent.length,
      sqlMismatches: (bal as { bad: number }).bad,
    },
  };
  mkdirSync(join(ROOT, 'load-results'), { recursive: true });
  writeFileSync(join(ROOT, 'load-results', `run-${RUN}.json`), JSON.stringify(result, null, 2));

  const reportPath = join(ROOT, 'docs', 'LOAD_TEST.md');
  const previous = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  const analysis =
    /<!-- ANALYSIS:START -->[\s\S]*<!-- ANALYSIS:END -->/.exec(previous)?.[0] ??
    '<!-- ANALYSIS:START -->\n_(preencher após a execução: gargalos, interpretação dos números, limitações do ambiente)_\n<!-- ANALYSIS:END -->';
  const row = (s: ReturnType<typeof summarize>) =>
    `| ${s.name} | ${s.requests} | ${s.elapsedS.toFixed(1)} | **${s.rps.toFixed(1)}** | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${ms(s.max)} | ${(s.errorRate * 100).toFixed(2)}% |`;
  const outcomes = (s: ReturnType<typeof summarize>) =>
    `| ${s.name} | ${s.ok} | ${s.replay} | ${s.pending} | ${s.business} ${
      Object.keys(s.failureCodes).length
        ? `(${Object.entries(s.failureCodes)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')})`
        : ''
    } | ${s.conflict} | ${s.client} | ${s.server} | ${s.network} |`;
  const crow = (label: string, c: typeof cA) =>
    `| ${label} | ${c.lockConflicts} (timeout ${c.lockTimeouts}, deadlock ${c.deadlocks}) | ${c.retries} | ${c.replays} | ${c.conflicts} | ${c.inboxDup} | ${c.lockWaitP50} | ${c.lockWaitP95} | ${c.lockWaitP99} |`;

  const report = `# Teste de carga

> Gerado por \`bun run test:load\` (\`scripts/load-test.ts\`) — execução \`${RUN}\` em ${new Date().toISOString()}.
> Dados brutos: \`load-results/run-${RUN}.json\` (não versionado). A seção **Análise** é escrita à mão e preservada entre execuções.

## Ambiente

| Item | Valor |
|---|---|
| CPU | ${environment.cpu} (${environment.cpus} threads lógicas) |
| RAM | ${environment.ramGb} GB |
| SO do host | ${environment.os} |
| Bun (gerador de carga) | ${environment.bun} |
| Docker | ${environment.docker} — Docker Desktop (WSL2) |
| Imagens | ${environment.images} |
| Topologia | 3 instâncias (\`app-1..3\`, cada uma com HTTP + consumer SQS + outbox publisher + worker de pendências), 1 PostgreSQL 16, 1 LocalStack 3.8 — todos no mesmo host |
| Pool de conexões | \`DB_POOL_MAX=20\` por instância; \`lock_timeout=5s\` |

## Metodologia

- **Parâmetros:** duração A = ${P.durationS}s, duração B = ${P.hotDurationS}s, concorrência = ${P.concurrency} workers virtuais, ${P.wallets} wallets (+1 hot) com saldo 1.000.000,00, fração hot no cenário A = ${P.hotShare}, ${P.sqsMessages} mensagens SQS.
- **Cenário A — HTTP closed-loop:** cada worker escolhe uma wallet (${P.hotShare * 100}% na hot wallet) e envia BET (~70%), WIN referenciando a última BET do worker (~20%), LOSS (~5%) e REFUND da última BET (~5%, uma única vez); ~2% das requisições são reenvios idênticos (medem replay). Round-robin entre as 3 instâncias. Latência medida no cliente (\`performance.now()\`), do envio ao corpo completo.
- **Cenário B — hot wallet:** 100% das requisições em uma única wallet — mede o custo da serialização pelo lock pessimista por wallet.
- **Cenário C — SQS:** ${P.sqsMessages} BETs enviadas com \`SendMessageBatch\` (8 produtores paralelos, \`MessageGroupId\` = wallet, ${Math.min(50, P.wallets)} grupos); mede o tempo até a fila ficar vazia (visíveis + em voo = 0) ⇒ throughput de consumo das 3 instâncias.
- **Coleta:** deltas de \`/metrics\` somados das 3 instâncias por cenário; \`wagering_outbox_oldest_pending_age_seconds\` amostrado a cada 1 s durante toda a execução; percentis de histograma reportados como limite superior do bucket.
- **Validação pós-carga:** \`POST /wallets/:id/reconciliation\` em todas as wallets do teste + verificação SQL independente (saldo = soma do ledger).
- **Erro** = 5xx + erros de rede. 422 (rejeição de negócio), 409 e 202 **não** são erros de infraestrutura e são reportados à parte.

## Resultados — HTTP

| Cenário | Requisições | Duração (s) | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro |
|---|---|---|---|---|---|---|---|---|
${row(A)}
${row(Acold)}
${row(Ahot)}
${row(B)}

Distribuição de respostas:

| Cenário | 2xx novo | 200 replay | 202 pendente | 422 negócio | 409 conflito | outros 4xx | 5xx | rede |
|---|---|---|---|---|---|---|---|---|
${outcomes(A)}
${outcomes(B)}

## Resultados — SQS (cenário C)

| Mensagens | Efetivadas no banco | Tempo de envio (s) | Tempo até fila vazia (s) | Throughput de consumo (msg/s) |
|---|---|---|---|---|
| ${P.sqsMessages} | ${sqsCommitted} | ${sendS.toFixed(1)} | ${sqsDrainS.toFixed(1)} | **${(P.sqsMessages / sqsDrainS).toFixed(1)}** |

## Concorrência (deltas de métricas, 3 instâncias)

| Cenário | Conflitos de lock | Retries internos | Replays | Conflitos de idempotência | Duplicatas inbox | Espera de lock p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|
${crow('A', cA)}
${crow('B', cB)}
${crow('C (SQS)', cC)}

## Outbox lag

| Métrica | Valor |
|---|---|
| Idade do evento pendente mais antigo — p50 / p95 / máx (amostras de 1 s, n=${lagSamples.length}) | ${result.outbox.lagP50S.toFixed(2)} s / ${result.outbox.lagP95S.toFixed(2)} s / ${result.outbox.lagMaxS.toFixed(2)} s |
| Máximo de eventos pendentes observado | ${result.outbox.pendingMax} |
| Lag de publicação (commit → publish) p50 / p95 — cenário A | ${cA.publishLagP50} / ${cA.publishLagP95} |
| Lag de publicação p50 / p95 — cenário C | ${cC.publishLagP50} / ${cC.publishLagP95} |
| Tempo para zerar o outbox após o fim da carga | ${outboxDrainS.toFixed(1)} s |

## Consistência pós-carga

| Wallets verificadas | Reconciliação inconsistente | Divergência SQL (saldo ≠ soma do ledger) |
|---|---|---|
| ${allWallets.length} | **${inconsistent.length}** | **${(bal as { bad: number }).bad}** |

## Análise

${analysis}
`;
  writeFileSync(reportPath, report);
  console.log(
    JSON.stringify(
      {
        A: { rps: A.rps, p50: A.p50, p95: A.p95, p99: A.p99, errorRate: A.errorRate },
        B: { rps: B.rps, p95: B.p95 },
        sqs: result.sqs,
        outbox: result.outbox,
        reconciliation: result.reconciliation,
      },
      null,
      2,
    ),
  );
  if (inconsistent.length > 0 || (bal as { bad: number }).bad > 0) {
    console.error(`INCONSISTENT WALLETS: ${inconsistent.join(', ')}`);
    process.exit(1);
  }
}

await main();
