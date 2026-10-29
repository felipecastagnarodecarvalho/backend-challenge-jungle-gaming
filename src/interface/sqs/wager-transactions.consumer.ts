import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type BeforeApplicationShutdown, Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { TransientInfrastructureError } from '../../application/errors';
import type { MetricsPort } from '../../application/ports/metrics';
import type { FaultInjector, LoggerPort } from '../../application/ports/system';
import { ProcessWagerTransactionUseCase } from '../../application/wager/process-wager-transaction.use-case';
import type { ProcessWagerResult } from '../../application/wager/wager-result';
import type { AppConfig } from '../../bootstrap/config';
import { APP_CONFIG, FAULT_INJECTOR, LOGGER, METRICS, QUEUE_REGISTRY, SQS_CLIENT } from '../../bootstrap/tokens';
import type { QueueRegistry } from '../../infrastructure/messaging/queue-registry';
import { classifyMessage, heartbeatIntervalMs, retryVisibilitySeconds } from './message-classifier';
import { parseEnvelope } from './sqs-envelope.schema';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Long-polling consumer of `wager-transactions.fifo`.
 *
 * - Reuses ProcessWagerTransactionUseCase (same path as HTTP); the inbox row
 *   is written in the same SQL transaction as the effects.
 * - Ack (DeleteMessage) only after the use case returned, i.e. after COMMIT.
 *   A crash between commit and ack → redelivery → inbox says DUPLICATE → ack.
 * - Messages of one MessageGroupId (wallet) run sequentially, groups in parallel.
 * - SIGTERM: stop polling, give not-yet-started messages back (visibility 0),
 *   let in-flight ones finish within the grace period, then release the rest.
 */
@Injectable()
export class WagerTransactionsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private stopping = false;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private readonly notStarted = new Map<string, Message>();
  private readonly inFlight = new Map<string, Message>();
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  private queueUrl: string | undefined;
  private dlqUrl: string | undefined;
  private readonly log: LoggerPort;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QUEUE_REGISTRY) private readonly queues: QueueRegistry,
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    @Inject(FAULT_INJECTOR) private readonly faults: FaultInjector,
    @Inject(LOGGER) logger: LoggerPort,
  ) {
    this.log = logger.child({ component: 'sqs-consumer' });
  }

  onApplicationBootstrap(): void {
    if (!this.config.sqs.consumerEnabled) return;
    this.loop = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.loop) return;
    this.stopping = true;
    this.abort.abort();
    // Received but not started: hand them back immediately to other instances.
    await this.releaseVisibility([...this.notStarted.values()]);
    const finished = await Promise.race([
      this.loop.then(() => true),
      sleep(this.config.shutdownGraceMs).then(() => false),
    ]);
    if (!finished) {
      // Grace period exceeded: release what is still running. If it commits later, redelivery is an inbox duplicate.
      this.log.warn({ inFlight: this.inFlight.size }, 'shutdown grace exceeded; releasing in-flight messages');
      await this.releaseVisibility([...this.inFlight.values(), ...this.notStarted.values()]);
    }
    this.log.info({}, 'sqs consumer stopped');
  }

  private async run(): Promise<void> {
    let backoffMs = 1000;
    while (!this.stopping) {
      try {
        this.queueUrl ??= await this.queues.url(this.config.sqs.wagerQueueName);
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: this.config.sqs.batchSize,
            WaitTimeSeconds: this.config.sqs.waitTimeS,
            VisibilityTimeout: this.config.sqs.visibilityTimeoutS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );
        backoffMs = 1000;
        const messages = response.Messages ?? [];
        if (messages.length === 0) continue;
        for (const m of messages) if (m.ReceiptHandle) this.notStarted.set(m.ReceiptHandle, m);
        await this.processBatch(messages);
      } catch (err) {
        if (this.stopping) break;
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err), backoffMs },
          'receive failed; backing off',
        );
        await sleep(backoffMs, this.abort.signal);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.allSettled(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) return; // left in notStarted → released by shutdown
          await this.handle(message);
        }
      }),
    );
  }

  private async handle(message: Message): Promise<void> {
    const receipt = message.ReceiptHandle as string;
    this.notStarted.delete(receipt);
    this.inFlight.set(receipt, message);
    this.startHeartbeat(receipt);
    const body = message.Body ?? '';
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let log = this.log.child({ sqsMessageId: message.MessageId, receiveCount });
    let messageId: string | undefined;
    let outcome: { result: ProcessWagerResult } | { error: unknown };
    try {
      const envelope = parseEnvelope(body);
      messageId = envelope.messageId;
      const correlationId = message.MessageAttributes?.correlationId?.StringValue ?? envelope.messageId;
      log = log.child({
        messageId,
        correlationId,
        walletId: envelope.data.walletId,
        providerId: envelope.data.providerId,
      });
      if (this.faults.transientFailure(envelope.messageId)) {
        throw new TransientInfrastructureError('injected');
      }
      const { idempotencyKey, ...data } = envelope.data;
      const result = await this.processWager.execute({
        ...data,
        idempotencyKey,
        correlationId,
        source: {
          type: 'SQS',
          consumerName: this.config.sqs.consumerName,
          messageId: envelope.messageId,
          messageHash: sha256(body),
        },
      });
      this.faults.afterCommit('sqs-before-ack', envelope.messageId);
      outcome = { result };
    } catch (error) {
      outcome = { error };
    }
    this.stopHeartbeat(receipt);

    try {
      const decision = classifyMessage(outcome);
      switch (decision.action) {
        case 'ACK':
          await this.delete(receipt);
          this.metrics.sqsMessage('ack');
          if (decision.duplicate) this.metrics.sqsMessage('duplicate');
          break;
        case 'DLQ':
          await this.sendToDlq(message, decision.errorCode, decision.errorMessage);
          await this.delete(receipt);
          this.metrics.sqsMessage('dlq');
          this.metrics.dlq(decision.reason);
          log.error(
            { errorCode: decision.errorCode, error: decision.errorMessage },
            decision.reason === 'invalid_payload'
              ? 'poison message sent to DLQ'
              : 'permanent failure: message sent to DLQ',
          );
          break;
        case 'RETRY': {
          const delay = retryVisibilitySeconds(receiveCount, this.config.sqs.retryBaseS, this.config.sqs.retryMaxS);
          await this.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: receipt,
              VisibilityTimeout: delay,
            }),
          );
          this.metrics.sqsMessage('retry');
          const err = 'error' in outcome ? outcome.error : undefined;
          const details = {
            reason: decision.reason,
            delaySeconds: delay,
            err: err instanceof Error ? err.message : String(err),
          };
          if (receiveCount >= this.config.sqs.maxReceiveCount) {
            log.error(details, 'message failed on its last attempt; redrive will move it to the DLQ');
          } else {
            log.warn(details, 'message processing failed; retry scheduled');
          }
          break;
        }
      }
    } catch (err) {
      // Delete/visibility failures are safe: the message reappears and the inbox dedupes it.
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to settle message');
    } finally {
      this.stopHeartbeat(receipt);
      this.inFlight.delete(receipt);
    }
  }

  private async delete(receipt: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receipt }));
  }

  private async sendToDlq(message: Message, errorCode: string, errorMessage: string): Promise<void> {
    this.dlqUrl ??= await this.queues.url(this.config.sqs.wagerDlqName);
    const body = message.Body ?? '';
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.dlqUrl,
        MessageBody: body.length > 0 ? body : '(empty)',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'poison',
        MessageDeduplicationId: sha256(body),
        MessageAttributes: {
          errorCode: { DataType: 'String', StringValue: errorCode },
          errorMessage: { DataType: 'String', StringValue: errorMessage || 'invalid' },
        },
      }),
    );
  }

  /**
   * Visibility heartbeat: while a message is being processed (it may wait in the
   * per-wallet queue behind a hot wallet), keep extending its visibility so it
   * does not reappear to another consumer, inflate ApproximateReceiveCount and
   * eventually be redriven to the DLQ although it is valid. Failures are only
   * logged: a lapsed visibility is still safe (the inbox dedupes the redelivery).
   */
  private startHeartbeat(receipt: string): void {
    const timer = setInterval(() => {
      this.sqs
        .send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: receipt,
            VisibilityTimeout: this.config.sqs.visibilityTimeoutS,
          }),
        )
        .catch((err: unknown) =>
          this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'visibility heartbeat failed'),
        );
    }, heartbeatIntervalMs(this.config.sqs.visibilityTimeoutS));
    this.heartbeats.set(receipt, timer);
  }

  private stopHeartbeat(receipt: string): void {
    const timer = this.heartbeats.get(receipt);
    if (timer) clearInterval(timer);
    this.heartbeats.delete(receipt);
  }

  private async releaseVisibility(messages: Message[]): Promise<void> {
    for (const m of messages) if (m.ReceiptHandle) this.stopHeartbeat(m.ReceiptHandle);
    if (!this.queueUrl || messages.length === 0) return;
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      try {
        await this.sqs.send(
          new ChangeMessageVisibilityBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((m, idx) => ({ Id: String(idx), ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 })),
          }),
        );
      } catch (err) {
        this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to release visibility');
      }
    }
  }
}
