import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { type ProviderIdentity, type ProviderIdentityPort, UnauthenticatedError } from '../../application/ports/system';

export interface JwksIdentityOptions {
  issuer: string;
  audience?: string;
  providerClaim: string;
  /** Key resolver: remote JWKS in production, local JWKS in tests. */
  keys: JWTVerifyGetKey;
}

/**
 * Verifies bearer JWTs issued by an external IdP (Keycloak) against its JWKS:
 * signature, `exp`/`nbf`, issuer and (optionally) audience. The provider id is
 * read from a dedicated claim (`provider_id`), set per client in the IdP —
 * there is no local user/password store.
 */
export class JwksProviderIdentity implements ProviderIdentityPort {
  constructor(private readonly opts: JwksIdentityOptions) {}

  static remote(o: Omit<JwksIdentityOptions, 'keys'> & { jwksUrl: string }): JwksProviderIdentity {
    return new JwksProviderIdentity({ ...o, keys: createRemoteJWKSet(new URL(o.jwksUrl)) });
  }

  async resolve(authorizationHeader: string | undefined): Promise<ProviderIdentity> {
    const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(authorizationHeader?.trim() ?? '');
    if (!match?.[1]) throw new UnauthenticatedError('Missing or malformed bearer token');
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(match[1], this.opts.keys, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        clockTolerance: 5,
      }));
    } catch {
      throw new UnauthenticatedError('Invalid or expired token');
    }
    const providerId = payload[this.opts.providerClaim];
    if (typeof providerId !== 'string' || providerId.length === 0) {
      throw new UnauthenticatedError(`Token lacks the "${this.opts.providerClaim}" claim`);
    }
    return { kind: 'provider', providerId, subject: typeof payload.sub === 'string' ? payload.sub : providerId };
  }
}
