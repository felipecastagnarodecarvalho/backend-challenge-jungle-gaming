import { SQSClient } from '@aws-sdk/client-sqs';

export interface SqsClientOptions {
  region: string;
  endpoint: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
}

/** SQS client pointed at LocalStack in dev/test (endpoint) or real AWS in production (no endpoint). */
export function createSqsClient(o: SqsClientOptions): SQSClient {
  return new SQSClient({
    region: o.region,
    endpoint: o.endpoint,
    credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
    maxAttempts: 3,
  });
}
