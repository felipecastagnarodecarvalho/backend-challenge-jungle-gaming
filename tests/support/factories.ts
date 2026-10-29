/** HTTP helpers and request builders for integration/concurrency tests. */
export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export async function http<T = Record<string, unknown>>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult<T>> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // keep raw text
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

export interface CreatedWallet {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export async function createWallet(
  baseUrl: string,
  amount = '1000.00',
  currency = 'BRL',
  playerId = crypto.randomUUID(),
) {
  const r = await http<CreatedWallet>('POST', `${baseUrl}/wallets`, { playerId, initialBalance: { amount, currency } });
  if (r.status !== 201) throw new Error(`createWallet failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wager(wallet: { id: string; playerId: string }, overrides: Partial<WagerBody> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

export interface WagerResponse {
  transactionId: string;
  status: string;
  failureCode: string | null;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  correlationId?: string;
}

export const keyOf = (b: WagerBody) => `${b.providerId}:${b.externalTransactionId}`;

export function postWager(baseUrl: string, body: WagerBody, key = keyOf(body), headers: Record<string, string> = {}) {
  return http<WagerResponse>('POST', `${baseUrl}/wagering/transactions`, body, { 'Idempotency-Key': key, ...headers });
}

/** Sums a metric (all label sets matching `labels`) from Prometheus text exposition. */
export function sumMetric(text: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) {
      total += Number(line.slice(line.lastIndexOf(' ') + 1));
    }
  }
  return total;
}

export async function scrape(baseUrl: string): Promise<string> {
  return (await fetch(`${baseUrl}/metrics`)).text();
}
