/**
 * Per-key FIFO serialization inside ONE process (keys = wallet ids).
 *
 * This is a throughput optimisation, never a correctness mechanism: the
 * guarantee across instances is the Postgres row lock (`SELECT … FOR UPDATE`).
 * Without it, N concurrent requests for a hot wallet each grab a pooled DB
 * connection just to wait on the row lock, starving requests for every other
 * wallet. With it, at most one transaction per wallet per instance waits on
 * the database; the rest wait here, holding no connection. Different keys
 * never block each other (no global lock), and the map holds only keys with
 * work in flight.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys currently queued or running (for tests/diagnostics). */
  get activeKeys(): number {
    return this.tails.size;
  }
}
