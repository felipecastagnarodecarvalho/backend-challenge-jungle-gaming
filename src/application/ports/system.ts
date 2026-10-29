import type { OutboxMessage } from '../messaging/outbox-message';

export interface Clock {
  now(): Date;
}

/** Time-ordered unique ids (UUID v7). */
export interface IdGenerator {
  next(): string;
}

export interface PublishResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** Broker adapter used only by the outbox publisher. */
export interface MessagePublisher {
  publishBatch(messages: OutboxMessage[]): Promise<PublishResult[]>;
}

export interface LoggerPort {
  child(bindings: Record<string, unknown>): LoggerPort;
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export type ProviderIdentity = { kind: 'anonymous' } | { kind: 'provider'; providerId: string; subject: string };

/** Extension point for authentication (external IdP). Throws UnauthenticatedError on bad credentials. */
export interface ProviderIdentityPort {
  resolve(authorizationHeader: string | undefined): Promise<ProviderIdentity>;
}

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHORIZED';
}

/** Test-only fault hooks (no-ops unless FAULT_INJECTION_ENABLED). */
export interface FaultInjector {
  afterCommit(point: 'sqs-before-ack', key: string): void;
  afterOutboxClaim(): void;
  delayInTransaction(): Promise<void>;
  transientFailure(key: string): boolean;
}

export const NoopFaultInjector: FaultInjector = {
  afterCommit: () => undefined,
  afterOutboxClaim: () => undefined,
  delayInTransaction: async () => undefined,
  transientFailure: () => false,
};
