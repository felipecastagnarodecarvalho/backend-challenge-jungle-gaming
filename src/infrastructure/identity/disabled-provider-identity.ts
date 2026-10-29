import type { ProviderIdentity, ProviderIdentityPort } from '../../application/ports/system';

/** Auth switched off (default): every caller is anonymous and allowed. The extension point stays explicit. */
export class DisabledProviderIdentity implements ProviderIdentityPort {
  async resolve(): Promise<ProviderIdentity> {
    return { kind: 'anonymous' };
  }
}
