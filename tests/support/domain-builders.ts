import { Money } from '../../src/domain/money/money';
import { type CreateWagerTransactionProps, WagerTransaction } from '../../src/domain/wager/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';

export const T0 = new Date('2026-10-29T12:00:00.000Z');
export const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

let seq = 0;
export const nextId = (): string => `id-${++seq}`;

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export function walletWith(
  amount: string,
  overrides: Partial<{ id: string; playerId: string; currency: string }> = {},
) {
  const currency = overrides.currency ?? 'BRL';
  const balance = Money.from({ amount, currency });
  return Wallet.rehydrate({
    id: overrides.id ?? WALLET,
    playerId: overrides.playerId ?? PLAYER,
    currency,
    balance,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

export function wagerTx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${nextId()}`;
  return WagerTransaction.create({
    id: nextId(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: WALLET,
    playerId: PLAYER,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: brl('10.00'),
    source: 'HTTP',
    createdAt: T0,
    ...overrides,
  });
}

/** A transaction already PROCESSED (e.g. a reference). */
export function processedTx(overrides: Partial<CreateWagerTransactionProps> = {}, refId?: string): WagerTransaction {
  const tx = wagerTx(overrides);
  tx.markProcessed({ at: T0, balanceAfter: brl('0.00'), walletVersion: 2, referenceTransactionId: refId });
  return tx;
}
