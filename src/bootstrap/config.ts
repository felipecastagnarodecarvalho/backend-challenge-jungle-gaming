import { hostname } from 'node:os';
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');
const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(3000),
    INSTANCE_ID: z.string().min(1).default(hostname()),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().min(1).default('postgresql://wagering:wagering@localhost:5432/wagering'),
    DB_POOL_MAX: int(20, 1),
    DB_LOCK_TIMEOUT_MS: int(5000, 1),
    DB_STATEMENT_TIMEOUT_MS: int(15000, 1),
    TX_MAX_ATTEMPTS: int(3, 1),

    AWS_REGION: z.string().default('us-east-1'),
    AWS_ENDPOINT_URL: optionalString.default('http://localhost:4566'),
    AWS_ACCESS_KEY_ID: z.string().default('test'),
    AWS_SECRET_ACCESS_KEY: z.string().default('test'),

    SQS_WAGER_QUEUE_NAME: z.string().default('wager-transactions.fifo'),
    SQS_WAGER_DLQ_NAME: z.string().default('wager-transactions-dlq.fifo'),
    SQS_EVENTS_QUEUE_NAME: z.string().default('wallet-events.fifo'),
    SQS_CONSUMER_NAME: z.string().default('wager-transactions-consumer'),
    SQS_MAX_RECEIVE_COUNT: int(5, 1),
    SQS_VISIBILITY_TIMEOUT_S: int(30, 0),
    SQS_WAIT_TIME_S: int(20, 0),
    SQS_BATCH_SIZE: int(10, 1),
    SQS_RETRY_BASE_S: int(2, 0),
    SQS_RETRY_MAX_S: int(300, 0),
    SQS_CONSUMER_ENABLED: bool(true),

    OUTBOX_PUBLISHER_ENABLED: bool(true),
    OUTBOX_POLL_INTERVAL_MS: int(500, 1),
    OUTBOX_BATCH_SIZE: int(50, 1),
    OUTBOX_LEASE_MS: int(30000, 1),
    OUTBOX_RETRY_BASE_MS: int(1000, 1),
    OUTBOX_RETRY_MAX_MS: int(300000, 1),

    PENDING_REF_WORKER_ENABLED: bool(true),
    PENDING_REF_POLL_INTERVAL_MS: int(1000, 1),
    PENDING_REF_BATCH_SIZE: int(20, 1),
    PENDING_REF_LEASE_MS: int(30000, 1),
    PENDING_REF_BASE_DELAY_MS: int(2000, 1),
    PENDING_REF_MAX_DELAY_MS: int(300000, 1),
    PENDING_REF_MAX_ATTEMPTS: int(10, 1),

    SHUTDOWN_GRACE_MS: int(25000, 0),

    AUTH_ENABLED: bool(false),
    AUTH_ISSUER: optionalString,
    AUTH_JWKS_URL: optionalString,
    AUTH_AUDIENCE: optionalString,
    AUTH_PROVIDER_CLAIM: z.string().default('provider_id'),

    FAULT_INJECTION_ENABLED: bool(false),
    FAULT_CRASH_AFTER_COMMIT_MESSAGE_IDS: csv,
    FAULT_CRASH_AFTER_OUTBOX_CLAIM: bool(false),
    FAULT_TRANSIENT_MESSAGE_IDS: csv,
    FAULT_DELAY_IN_TX_MS: int(0, 0),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_ENABLED && (!env.AUTH_ISSUER || !env.AUTH_JWKS_URL)) {
      ctx.addIssue({ code: 'custom', message: 'AUTH_ISSUER and AUTH_JWKS_URL are required when AUTH_ENABLED=true' });
    }
    if (env.FAULT_INJECTION_ENABLED && env.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', message: 'FAULT_INJECTION_ENABLED is refused in production' });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Typed, immutable application configuration (validated once at startup). */
export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  instanceId: string;
  logLevel: Env['LOG_LEVEL'];
  db: { url: string; poolMax: number; lockTimeoutMs: number; statementTimeoutMs: number; txMaxAttempts: number };
  aws: { region: string; endpoint: string | undefined; accessKeyId: string; secretAccessKey: string };
  sqs: {
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    consumerName: string;
    maxReceiveCount: number;
    visibilityTimeoutS: number;
    waitTimeS: number;
    batchSize: number;
    retryBaseS: number;
    retryMaxS: number;
    consumerEnabled: boolean;
  };
  outbox: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
  pendingRef: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    baseDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
  };
  shutdownGraceMs: number;
  auth: {
    enabled: boolean;
    issuer: string | undefined;
    jwksUrl: string | undefined;
    audience: string | undefined;
    providerClaim: string;
  };
  faults: {
    enabled: boolean;
    crashAfterCommitMessageIds: readonly string[];
    crashAfterOutboxClaim: boolean;
    transientMessageIds: readonly string[];
    delayInTxMs: number;
  };
}

export class ConfigError extends Error {}

function deepFreeze<T>(obj: T): T {
  for (const value of Object.values(obj as object)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * Validates the environment (plus optional overrides, used by tests) and
 * returns a frozen config. Throws {@link ConfigError} with every issue listed.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Record<string, string | undefined> = {},
): AppConfig {
  const parsed = envSchema.safeParse({ ...env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  return deepFreeze<AppConfig>({
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    instanceId: e.INSTANCE_ID,
    logLevel: e.LOG_LEVEL,
    db: {
      url: e.DATABASE_URL,
      poolMax: e.DB_POOL_MAX,
      lockTimeoutMs: e.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      txMaxAttempts: e.TX_MAX_ATTEMPTS,
    },
    aws: {
      region: e.AWS_REGION,
      endpoint: e.AWS_ENDPOINT_URL,
      accessKeyId: e.AWS_ACCESS_KEY_ID,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
    },
    sqs: {
      wagerQueueName: e.SQS_WAGER_QUEUE_NAME,
      wagerDlqName: e.SQS_WAGER_DLQ_NAME,
      eventsQueueName: e.SQS_EVENTS_QUEUE_NAME,
      consumerName: e.SQS_CONSUMER_NAME,
      maxReceiveCount: e.SQS_MAX_RECEIVE_COUNT,
      visibilityTimeoutS: e.SQS_VISIBILITY_TIMEOUT_S,
      waitTimeS: e.SQS_WAIT_TIME_S,
      batchSize: e.SQS_BATCH_SIZE,
      retryBaseS: e.SQS_RETRY_BASE_S,
      retryMaxS: e.SQS_RETRY_MAX_S,
      consumerEnabled: e.SQS_CONSUMER_ENABLED,
    },
    outbox: {
      enabled: e.OUTBOX_PUBLISHER_ENABLED,
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      leaseMs: e.OUTBOX_LEASE_MS,
      retryBaseMs: e.OUTBOX_RETRY_BASE_MS,
      retryMaxMs: e.OUTBOX_RETRY_MAX_MS,
    },
    pendingRef: {
      enabled: e.PENDING_REF_WORKER_ENABLED,
      pollIntervalMs: e.PENDING_REF_POLL_INTERVAL_MS,
      batchSize: e.PENDING_REF_BATCH_SIZE,
      leaseMs: e.PENDING_REF_LEASE_MS,
      baseDelayMs: e.PENDING_REF_BASE_DELAY_MS,
      maxDelayMs: e.PENDING_REF_MAX_DELAY_MS,
      maxAttempts: e.PENDING_REF_MAX_ATTEMPTS,
    },
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    auth: {
      enabled: e.AUTH_ENABLED,
      issuer: e.AUTH_ISSUER,
      jwksUrl: e.AUTH_JWKS_URL,
      audience: e.AUTH_AUDIENCE,
      providerClaim: e.AUTH_PROVIDER_CLAIM,
    },
    faults: {
      enabled: e.FAULT_INJECTION_ENABLED,
      crashAfterCommitMessageIds: e.FAULT_CRASH_AFTER_COMMIT_MESSAGE_IDS,
      crashAfterOutboxClaim: e.FAULT_CRASH_AFTER_OUTBOX_CLAIM,
      transientMessageIds: e.FAULT_TRANSIENT_MESSAGE_IDS,
      delayInTxMs: e.FAULT_DELAY_IN_TX_MS,
    },
  });
}
