/** Semantic metrics port: the application states facts, the adapter decides names/labels. */
export interface MetricsPort {
  transactionCompleted(p: {
    kind: string;
    status: string;
    source: string;
    replay: boolean;
    durationMs: number;
    outcome: string;
  }): void;
  rejection(failureCode: string): void;
  duplicate(source: 'http' | 'sqs', type: 'replay' | 'conflict' | 'inbox'): void;
  retry(operation: string, reason: string): void;
  lockConflict(reason: 'lock_timeout' | 'deadlock' | 'serialization'): void;
  lockWait(seconds: number): void;
  sqsMessage(result: 'ack' | 'duplicate' | 'retry' | 'dlq'): void;
  dlq(reason: string): void;
  outboxPublished(eventType: string, lagSeconds: number): void;
  outboxFailure(): void;
  pendingReferenceRetry(): void;
  pendingReferenceExpired(): void;
  reconciliation(consistent: boolean): void;
}

export const NoopMetrics: MetricsPort = {
  transactionCompleted: () => undefined,
  rejection: () => undefined,
  duplicate: () => undefined,
  retry: () => undefined,
  lockConflict: () => undefined,
  lockWait: () => undefined,
  sqsMessage: () => undefined,
  dlq: () => undefined,
  outboxPublished: () => undefined,
  outboxFailure: () => undefined,
  pendingReferenceRetry: () => undefined,
  pendingReferenceExpired: () => undefined,
  reconciliation: () => undefined,
};
