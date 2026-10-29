import { describe, expect, test } from 'bun:test';
import { KeyedSerializer } from '../../../src/application/shared/keyed-serializer';

describe('KeyedSerializer', () => {
  test('same key runs strictly one at a time, in arrival order', async () => {
    const gate = new KeyedSerializer();
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        gate.run('w1', async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await Bun.sleep(2);
          order.push(i);
          running--;
        }),
      ),
    );
    expect(maxRunning).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(gate.activeKeys).toBe(0);
  });

  test('different keys run in parallel (no global lock)', async () => {
    const gate = new KeyedSerializer();
    let running = 0;
    let maxRunning = 0;
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((k) =>
        gate.run(k, async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await Bun.sleep(10);
          running--;
        }),
      ),
    );
    expect(maxRunning).toBe(4);
  });

  test('a failure releases the key and propagates', async () => {
    const gate = new KeyedSerializer();
    await expect(gate.run('w', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await gate.run('w', async () => 'next')).toBe('next');
    expect(gate.activeKeys).toBe(0);
  });
});
