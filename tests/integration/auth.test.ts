import { describe, expect, test } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { JwksProviderIdentity } from '../../src/infrastructure/identity/jwks-provider-identity';
import { http, postWager, wager } from '../support/factories';
import { useApp } from '../support/harness';

/**
 * Auth ON through the real HTTP stack (guard + filter + controllers). The IdP
 * is replaced by a local JWKS here; a real Keycloak token is verified manually
 * against the compose `auth` profile (see README).
 */
const ISSUER = 'http://localhost:8080/realms/wagering';
const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
const identity = new JwksProviderIdentity({
  issuer: ISSUER,
  providerClaim: 'provider_id',
  keys: createLocalJWKSet({ keys: [jwk] }),
});

const ctx = useApp('auth', { SQS_CONSUMER_ENABLED: 'false' }, { identity });

const tokenFor = (providerId: string) =>
  new SignJWT({ provider_id: providerId })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

describe('authentication enabled', () => {
  test('health and metrics stay public', async () => {
    expect((await http('GET', `${ctx.url}/health/live`)).status).toBe(200);
    expect((await http('GET', `${ctx.url}/health/ready`)).status).toBe(200);
    expect((await fetch(`${ctx.url}/metrics`)).status).toBe(200);
  });

  test('401 without/with invalid token, 403 for another provider, 201 for the right one', async () => {
    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
    const a = await tokenFor('provider-a');
    const noToken = await http('POST', `${ctx.url}/wallets`, {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });
    expect(noToken.status).toBe(401);
    expect(noToken.body).toMatchObject({ error: { code: 'UNAUTHORIZED', retryable: false } });
    expect(
      (await http('GET', `${ctx.url}/wallets/${crypto.randomUUID()}`, undefined, auth('garbage.token.x'))).status,
    ).toBe(401);

    const created = await http<{ id: string; playerId: string }>(
      'POST',
      `${ctx.url}/wallets`,
      { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
      auth(a),
    );
    expect(created.status).toBe(201);
    const w = created.body;

    const asB = await postWager(ctx.url, wager(w, { providerId: 'provider-b' }), undefined, auth(a));
    expect(asB.status).toBe(403);
    expect(asB.body).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const ok = await postWager(ctx.url, wager(w), undefined, auth(a));
    expect(ok.status).toBe(201);

    // provider-b cannot see provider-a's transaction (404, not 403: no existence leak) nor query its namespace
    const b = await tokenFor('provider-b');
    expect(
      (await http('GET', `${ctx.url}/wagering/transactions/${ok.body.transactionId}`, undefined, auth(b))).status,
    ).toBe(404);
    expect(
      (await http('GET', `${ctx.url}/wagering/transactions/${ok.body.transactionId}`, undefined, auth(a))).status,
    ).toBe(200);
    expect(
      (await http('GET', `${ctx.url}/providers/provider-a/wagering/transactions/x`, undefined, auth(b))).status,
    ).toBe(403);
  });

  test('idempotency keys are per provider: provider-b cannot squat provider-a keys nor learn its ids', async () => {
    const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
    const a = await tokenFor('provider-a');
    const b = await tokenFor('provider-b');
    const w = (
      await http<{ id: string; playerId: string }>(
        'POST',
        `${ctx.url}/wallets`,
        { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
        auth(a),
      )
    ).body;
    const aOp = wager(w);
    const key = `provider-a:${aOp.externalTransactionId}`; // the default key provider-a will use

    // provider-b grabs that key first for its own operation: allowed, but only within provider-b's scope
    const squat = await postWager(ctx.url, wager(w, { providerId: 'provider-b' }), key, auth(b));
    expect(squat.status).toBe(201);

    // provider-a's legitimate request is not blocked (no 409) and gets its own transaction
    const legit = await postWager(ctx.url, aOp, key, auth(a));
    expect(legit.status).toBe(201);
    expect(legit.body.transactionId).not.toBe(squat.body.transactionId);

    // provider-b reusing the key with another payload conflicts only with its own transaction
    const conflict = await postWager(ctx.url, wager(w, { providerId: 'provider-b' }), key, auth(b));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { details: { existingTransactionId: squat.body.transactionId } } });
  });
});
