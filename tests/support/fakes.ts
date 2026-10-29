/**
 * In-memory port fakes — ONLY for unit tests of application logic.
 * Integration and concurrency tests always use real Postgres and SQS.
 */
import type { InboxMessage } from '../../src/application/messaging/inbox-message';
import { OutboxMessage } from '../../src/application/messaging/outbox-message';
import type { InboxReceiveResult } from '../../src/application/ports/inbox-repository';
import type { MetricsPort } from '../../src/application/ports/metrics';
import type { Clock, IdGenerator, LoggerPort } from '../../src/application/ports/system';
import type { TransactionScope, UnitOfWork } from '../../src/application/ports/unit-of-work';
import type { PendingReferenceClaim } from '../../src/application/ports/wager-transaction-repository';
import type { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { WagerTransaction } from '../../src/domain/wager/wager-transaction';
import type { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status';
import { Wallet } from '../../src/domain/wallet/wallet';

const cloneWallet = (w: Wallet) =>
  Wallet.rehydrate({
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance,
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });

const cloneTx = (t: WagerTransaction) =>
  WagerTransaction.rehydrate({
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    source: t.source,
    correlationId: t.correlationId,
    createdAt: t.createdAt,
    status: t.status,
    referenceTransactionId: t.referenceTransactionId,
    failureCode: t.failureCode,
    processedAt: t.processedAt,
    resultBalance: t.resultBalance,
    resultWalletVersion: t.resultWalletVersion,
    referenceAttempts: t.referenceAttempts,
    nextReferenceCheckAt: t.nextReferenceCheckAt,
    updatedAt: t.updatedAt,
  });

export class InMemoryStore {
  wallets = new Map<string, Wallet>();
  transactions = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  inbox = new Map<string, { hash: string; processed: boolean; transactionId?: string }>();
  outbox: OutboxMessage[] = [];

  snapshot() {
    return {
      wallets: new Map(this.wallets),
      transactions: new Map(this.transactions),
      ledger: [...this.ledger],
      inbox: new Map(this.inbox),
      outbox: [...this.outbox],
    };
  }

  restore(s: ReturnType<InMemoryStore['snapshot']>) {
    Object.assign(this, s);
  }
}

/** Serial in-memory unit of work with rollback on throw. */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(readonly store = new InMemoryStore()) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const snap = this.store.snapshot();
    try {
      return await work(this.scope());
    } catch (err) {
      this.store.restore(snap);
      throw err;
    }
  }

  private scope(): TransactionScope {
    const s = this.store;
    return {
      wallets: {
        findByIdForUpdate: async (id) => {
          const w = s.wallets.get(id);
          return w ? cloneWallet(w) : null;
        },
        insert: async (w) => {
          s.wallets.set(w.id, cloneWallet(w));
        },
        saveBalance: async (w, expected) => {
          const cur = s.wallets.get(w.id);
          if (!cur || cur.version !== expected) throw new Error('version mismatch');
          s.wallets.set(w.id, cloneWallet(w));
        },
      },
      transactions: {
        findForIdempotency: async (key, provider, ext) =>
          [...s.transactions.values()]
            .filter((t) => t.idempotencyKey === key || (t.providerId === provider && t.externalTransactionId === ext))
            .map(cloneTx),
        findByProviderExternalId: async (provider, ext) => {
          const t = [...s.transactions.values()].find(
            (x) => x.providerId === provider && x.externalTransactionId === ext,
          );
          return t ? cloneTx(t) : null;
        },
        findByIdForUpdate: async (id) => {
          const t = s.transactions.get(id);
          return t ? cloneTx(t) : null;
        },
        hasProcessedReversal: async (refId) =>
          [...s.transactions.values()].some(
            (t) => t.referenceTransactionId === refId && t.status === 'PROCESSED' && t.isReversal(),
          ),
        insertIfAbsent: async (tx) => {
          const clash = [...s.transactions.values()].some(
            (t) =>
              t.idempotencyKey === tx.idempotencyKey ||
              (t.providerId === tx.providerId && t.externalTransactionId === tx.externalTransactionId),
          );
          if (clash) return false;
          s.transactions.set(tx.id, cloneTx(tx));
          return true;
        },
        update: async (tx, expected: WagerTransactionStatus) => {
          const cur = s.transactions.get(tx.id);
          if (!cur || cur.status !== expected) throw new Error('status mismatch');
          s.transactions.set(tx.id, cloneTx(tx));
        },
        claimDuePendingReferences: async (): Promise<PendingReferenceClaim[]> =>
          [...s.transactions.values()]
            .filter((t) => t.status === 'PENDING_REFERENCE')
            .map((t) => ({ id: t.id, walletId: t.walletId })),
        nudgeAwaiting: async () => 0,
      },
      ledger: {
        append: async (e) => {
          s.ledger.push(e);
        },
      },
      inbox: {
        tryReceive: async (m: InboxMessage): Promise<InboxReceiveResult> => {
          const key = `${m.consumerName}|${m.messageId}`;
          const existing = s.inbox.get(key);
          if (existing) return { status: 'DUPLICATE', existingPayloadHash: existing.hash };
          s.inbox.set(key, { hash: m.payloadHash, processed: false });
          return { status: 'RECEIVED' };
        },
        markProcessed: async (m) => {
          s.inbox.set(`${m.consumerName}|${m.messageId}`, {
            hash: m.payloadHash,
            processed: true,
            transactionId: m.transactionId,
          });
        },
      },
      outbox: {
        enqueue: async (msgs) => {
          s.outbox.push(...msgs);
        },
        claimDue: async (limit) => s.outbox.filter((m) => m.isPending()).slice(0, limit),
        markPublished: async (ids, at) => {
          let n = 0;
          for (const m of s.outbox) {
            if (ids.includes(m.id) && m.isPending()) {
              m.markPublished(at);
              n++;
            }
          }
          return n;
        },
        saveRetry: async () => undefined,
      },
    };
  }
}

export class FixedClock implements Clock {
  constructor(public current = new Date('2026-10-29T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `00000000-0000-7000-8000-${this.n.toString().padStart(12, '0')}`;
  }
}

export const silentLogger: LoggerPort = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Records metric calls for assertions. */
export function recordingMetrics(): MetricsPort & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => {
      if (prop === 'calls') return calls;
      return (...args: unknown[]) => {
        calls.push([String(prop), args]);
      };
    },
  };
  return new Proxy({}, handler) as MetricsPort & { calls: Array<[string, unknown[]]> };
}

export { OutboxMessage };
