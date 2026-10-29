export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
  transactionId: string | undefined;
}

/**
 * Persistent deduplication record for a consumed message, keyed by
 * `(consumerName, messageId)`. Inserted in the same SQL transaction as the
 * effects, so "seen" and "applied" can never diverge — a redelivery after a
 * crash between commit and ack finds the row and becomes a no-op.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
    private _transactionId: string | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName) {
      throw new Error('inbox message requires messageId and consumerName');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage(s.messageId, s.consumerName, s.payloadHash, s.receivedAt, s.processedAt, s.transactionId);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get transactionId(): string | undefined {
    return this._transactionId;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Records completion; `transactionId` links to the resulting wager transaction (null when none was created). */
  markProcessed(at: Date, transactionId?: string): void {
    if (this.isProcessed()) {
      throw new Error(`inbox message ${this.messageId} already processed`);
    }
    if (at.getTime() < this.receivedAt.getTime()) {
      throw new Error('processedAt must not precede receivedAt');
    }
    this._processedAt = at;
    this._transactionId = transactionId;
  }
}
