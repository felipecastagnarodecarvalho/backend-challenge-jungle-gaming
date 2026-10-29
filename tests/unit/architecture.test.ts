import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

function imports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
}

const FRAMEWORK = /^(@nestjs|@mikro-orm|@aws-sdk|pino|nestjs-pino|prom-client|zod|jose|bun)(\/|$)/;

describe('architecture: dependency rule', () => {
  test('domain imports only decimal.js and other domain files', () => {
    const violations: string[] = [];
    for (const f of files(join(ROOT, 'domain'))) {
      for (const spec of imports(f)) {
        const ok =
          spec === 'decimal.js' ||
          (spec.startsWith('.') &&
            !spec.includes('application') &&
            !spec.includes('infrastructure') &&
            !spec.includes('interface'));
        if (!ok || spec.startsWith('node:')) violations.push(`${relative(ROOT, f)} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('application does not import frameworks or outer layers', () => {
    const violations: string[] = [];
    for (const f of files(join(ROOT, 'application'))) {
      for (const spec of imports(f)) {
        if (FRAMEWORK.test(spec) || /\/(infrastructure|interface|bootstrap)\//.test(spec)) {
          violations.push(`${relative(ROOT, f)} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
