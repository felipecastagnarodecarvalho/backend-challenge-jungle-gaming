/** Polls `predicate` until it returns a truthy value (no fixed sleeps in assertions). */
export async function waitFor<T>(
  predicate: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  opts: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value as T;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms${opts.description ? ` (${opts.description})` : ''}${
          lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''
        }`,
      );
    }
    await Bun.sleep(intervalMs);
  }
}
