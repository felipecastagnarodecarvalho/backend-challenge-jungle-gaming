/**
 * Shared configuration for integration/concurrency tests: a separate database
 * (`wagering_test`) on the compose Postgres and short worker intervals.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering_test';
export const TEST_AWS_ENDPOINT = process.env.TEST_AWS_ENDPOINT_URL ?? 'http://localhost:4566';

/** Base environment for app instances under test (queue names are added per test file). */
export function baseTestEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'warn',
    DATABASE_URL: TEST_DATABASE_URL,
    DB_POOL_MAX: '10',
    AWS_ENDPOINT_URL: TEST_AWS_ENDPOINT,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    SQS_VISIBILITY_TIMEOUT_S: '2',
    SQS_WAIT_TIME_S: '1',
    SQS_MAX_RECEIVE_COUNT: '3',
    SQS_RETRY_BASE_S: '1',
    SQS_RETRY_MAX_S: '2',
    OUTBOX_POLL_INTERVAL_MS: '100',
    OUTBOX_LEASE_MS: '2000',
    OUTBOX_RETRY_BASE_MS: '200',
    OUTBOX_RETRY_MAX_MS: '1000',
    PENDING_REF_POLL_INTERVAL_MS: '100',
    PENDING_REF_LEASE_MS: '2000',
    PENDING_REF_BASE_DELAY_MS: '100',
    PENDING_REF_MAX_DELAY_MS: '400',
    PENDING_REF_MAX_ATTEMPTS: '3',
    SHUTDOWN_GRACE_MS: '10000',
    AUTH_ENABLED: 'false',
    FAULT_INJECTION_ENABLED: 'true',
  };
}
