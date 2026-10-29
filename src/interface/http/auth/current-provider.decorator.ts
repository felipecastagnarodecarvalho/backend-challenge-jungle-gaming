import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ProviderIdentity } from '../../../application/ports/system';
import { HttpProblem } from '../http-error';

export const IDENTITY_KEY = 'wageringIdentity';

/** Injects the identity resolved by ProviderAuthGuard (anonymous when auth is disabled). */
export const CurrentProvider = createParamDecorator((_data: unknown, ctx: ExecutionContext): ProviderIdentity => {
  const req = ctx.switchToHttp().getRequest<Record<string, unknown>>();
  return (req[IDENTITY_KEY] as ProviderIdentity | undefined) ?? { kind: 'anonymous' };
});

/** A token for provider X may only act on provider X's resources. Anonymous (auth off) passes. */
export function assertProviderAccess(identity: ProviderIdentity, providerId: string): void {
  if (identity.kind === 'provider' && identity.providerId !== providerId) {
    throw new HttpProblem(403, 'FORBIDDEN', 'Token provider does not match the requested provider');
  }
}
