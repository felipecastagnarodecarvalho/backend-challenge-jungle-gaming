import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ProviderIdentityPort } from '../../../application/ports/system';
import { PROVIDER_IDENTITY } from '../../../bootstrap/tokens';
import { IDENTITY_KEY } from './current-provider.decorator';
import { IS_PUBLIC } from './public.decorator';

/**
 * Global guard. Public routes always pass; otherwise the identity is resolved
 * through ProviderIdentityPort (no-op when AUTH_ENABLED=false, JWT/JWKS from the
 * external IdP when enabled) and attached to the request. Authentication
 * failures surface as 401 via the exception filter; per-provider authorization
 * (403) is checked where the provider id is known.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> } & Record<string, unknown>>();
    req[IDENTITY_KEY] = await this.identity.resolve(req.headers.authorization);
    return true;
  }
}
