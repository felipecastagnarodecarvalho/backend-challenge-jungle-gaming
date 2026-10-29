import { beforeAll, describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { type ProviderIdentity, UnauthenticatedError } from '../../../src/application/ports/system';
import { DisabledProviderIdentity } from '../../../src/infrastructure/identity/disabled-provider-identity';
import { JwksProviderIdentity } from '../../../src/infrastructure/identity/jwks-provider-identity';
import { assertProviderAccess, IDENTITY_KEY } from '../../../src/interface/http/auth/current-provider.decorator';
import { ProviderAuthGuard } from '../../../src/interface/http/auth/provider-auth.guard';
import { IS_PUBLIC } from '../../../src/interface/http/auth/public.decorator';
import { HttpProblem } from '../../../src/interface/http/http-error';

const ISSUER = 'http://localhost:8080/realms/wagering';
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let identity: JwksProviderIdentity;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  identity = new JwksProviderIdentity({
    issuer: ISSUER,
    audience: 'wagering-api',
    providerClaim: 'provider_id',
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
});

async function token(
  opts: { key?: CryptoKey; exp?: string | number; claims?: Record<string, unknown>; iss?: string; aud?: string } = {},
) {
  return new SignJWT({ provider_id: 'provider-a', ...opts.claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? 'wagering-api')
    .setSubject('service-account-provider-a')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey);
}

function context(isPublic: boolean, authorization?: string) {
  const handler = () => undefined;
  class Ctl {}
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC, true, handler);
  const req: Record<string, unknown> = { headers: { authorization } };
  const ctx = {
    getHandler: () => handler,
    getClass: () => Ctl,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('ProviderAuthGuard', () => {
  test('public routes pass without credentials even with auth enabled', async () => {
    const guard = new ProviderAuthGuard(new Reflector(), identity);
    const { ctx, req } = context(true);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(req[IDENTITY_KEY]).toBeUndefined();
  });

  test('auth disabled: anonymous identity, everything passes', async () => {
    const guard = new ProviderAuthGuard(new Reflector(), new DisabledProviderIdentity());
    const { ctx, req } = context(false);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(req[IDENTITY_KEY]).toEqual({ kind: 'anonymous' });
  });

  test('valid token: provider identity attached', async () => {
    const guard = new ProviderAuthGuard(new Reflector(), identity);
    const { ctx, req } = context(false, `Bearer ${await token()}`);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(req[IDENTITY_KEY]).toEqual({
      kind: 'provider',
      providerId: 'provider-a',
      subject: 'service-account-provider-a',
    });
  });

  test.each([
    ['missing header', async () => undefined],
    ['not bearer', async () => 'Basic abc'],
    ['expired', async () => `Bearer ${await token({ exp: Math.floor(Date.now() / 1000) - 60 })}`],
    ['bad signature', async () => `Bearer ${await token({ key: otherKey })}`],
    ['wrong issuer', async () => `Bearer ${await token({ iss: 'http://evil/realms/x' })}`],
    ['wrong audience', async () => `Bearer ${await token({ aud: 'other-api' })}`],
    ['no provider claim', async () => `Bearer ${await token({ claims: { provider_id: undefined } })}`],
    ['garbage', async () => 'Bearer not.a.jwt'],
  ])('rejects %s with 401 (UnauthenticatedError)', async (_label, header) => {
    const guard = new ProviderAuthGuard(new Reflector(), identity);
    const { ctx } = context(false, await header());
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('per-provider authorization', () => {
  const providerA: ProviderIdentity = { kind: 'provider', providerId: 'provider-a', subject: 's' };
  test('same provider passes, different provider is 403, anonymous passes (auth off)', () => {
    expect(() => assertProviderAccess(providerA, 'provider-a')).not.toThrow();
    try {
      assertProviderAccess(providerA, 'provider-b');
      throw new Error('expected 403');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpProblem);
      expect((err as HttpProblem).status).toBe(403);
      expect((err as HttpProblem).code).toBe('FORBIDDEN');
    }
    expect(() => assertProviderAccess({ kind: 'anonymous' }, 'provider-b')).not.toThrow();
  });
});
