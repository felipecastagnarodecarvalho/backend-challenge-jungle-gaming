import { createHash } from 'node:crypto';
import { canonicalJson } from '../shared/canonical-json';
import type { WagerRequestData } from './process-wager-command';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Builds the canonical string hashed for idempotency: exactly the 9 business
 * fields (no idempotency key, message id, correlation id or timestamps).
 * A missing reference is represented as `null` (absent ≡ null). Values are
 * already normalised by validation, so no trimming/case folding happens here.
 */
export function canonicalWagerPayload(data: WagerRequestData): string {
  return canonicalJson({
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: { amount: data.money.amount, currency: data.money.currency },
    referenceExternalTransactionId: data.referenceExternalTransactionId ?? null,
  });
}

/** `payloadHash = hex(sha256(utf8(canonicalJson(businessFields))))`. Same key + different hash = conflict. */
export function computeWagerPayloadHash(data: WagerRequestData): string {
  return sha256Hex(canonicalWagerPayload(data));
}
