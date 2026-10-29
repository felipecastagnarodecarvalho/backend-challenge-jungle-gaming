import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { baseTestEnv } from './env';

const ROOT = join(import.meta.dir, '..', '..');

export interface AppProcess {
  name: string;
  url: string;
  port: number;
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  logs: string[];
  exited: Promise<number>;
  waitReady(timeoutMs?: number): Promise<void>;
  /** Forced termination (SIGKILL semantics; TerminateProcess on Windows): no shutdown hooks run. */
  kill(): Promise<number>;
  /** Graceful stop request (SIGTERM). On Windows Bun cannot deliver SIGTERM, so this degrades to a kill. */
  stop(): Promise<number>;
  dumpLogs(): string;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function pump(stream: ReadableStream<Uint8Array>, sink: string[], name: string): Promise<void> {
  const decoder = new TextDecoder();
  let carry = '';
  for await (const chunk of stream) {
    carry += decoder.decode(chunk, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      sink.push(`[${name}] ${line}`);
      if (sink.length > 5000) sink.shift();
    }
  }
  if (carry) sink.push(`[${name}] ${carry}`);
}

/**
 * Spawns a real application process (`bun src/main.ts`) with its own
 * connection pool — real parallelism, not interleaved promises in one process.
 */
export async function spawnApp(name: string, env: Record<string, string> = {}): Promise<AppProcess> {
  const port = await freePort();
  const logs: string[] = [];
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...baseTestEnv(), INSTANCE_ID: name, PORT: String(port), LOG_LEVEL: 'info', ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  void pump(proc.stdout, logs, name);
  void pump(proc.stderr, logs, name);
  const url = `http://127.0.0.1:${port}`;
  let exitCode: number | undefined;
  const exited = proc.exited.then((code) => {
    exitCode = code;
    return code;
  });

  const app: AppProcess = {
    name,
    url,
    port,
    proc,
    logs,
    exited,
    async waitReady(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (exitCode !== undefined) throw new Error(`${name} exited (${exitCode}) before ready:\n${app.dumpLogs()}`);
        try {
          const r = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(2000) });
          if (r.status === 200) return;
        } catch {
          // not listening yet
        }
        await Bun.sleep(100);
      }
      throw new Error(`${name} not ready after ${timeoutMs}ms:\n${app.dumpLogs()}`);
    },
    async kill() {
      if (exitCode === undefined) proc.kill('SIGKILL');
      return exited;
    },
    async stop() {
      if (exitCode === undefined) proc.kill('SIGTERM');
      return exited;
    },
    dumpLogs() {
      return logs.slice(-200).join('\n');
    },
  };
  return app;
}

/** Starts `n` instances in parallel and waits until all are ready. */
export async function startCluster(n: number, env: Record<string, string> = {}, prefix = 'app'): Promise<AppProcess[]> {
  const apps = await Promise.all(Array.from({ length: n }, (_, i) => spawnApp(`${prefix}-${i + 1}`, env)));
  try {
    await Promise.all(apps.map((a) => a.waitReady()));
  } catch (err) {
    await Promise.all(apps.map((a) => a.kill()));
    throw err;
  }
  return apps;
}

export async function stopAll(apps: AppProcess[]): Promise<void> {
  await Promise.all(apps.map((a) => a.kill()));
}
