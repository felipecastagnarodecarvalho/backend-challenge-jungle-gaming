import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';

/** Resolves (and caches) queue URLs/ARNs by name. */
export class QueueRegistry {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(private readonly client: SQSClient) {}

  url(name: string): Promise<string> {
    let cached = this.urls.get(name);
    if (!cached) {
      cached = this.client.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => {
        if (!r.QueueUrl) throw new Error(`queue ${name} has no URL`);
        return r.QueueUrl;
      });
      // Do not cache failures (queue may be created later).
      cached.catch(() => this.urls.delete(name));
      this.urls.set(name, cached);
    }
    return cached;
  }

  async arn(name: string): Promise<string> {
    const url = await this.url(name);
    const r = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
    const arn = r.Attributes?.QueueArn;
    if (!arn) throw new Error(`queue ${name} has no ARN`);
    return arn;
  }
}
