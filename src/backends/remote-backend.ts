import type { VaultBackend } from './vault-backend.js';

// Placeholder for the agentage cloud backend (a transparent passthrough proxy to the
// hosted MCP endpoint). Not implemented yet; until then a cloud-only vault has no
// usable backend, and touching it fails loudly rather than silently.
export const createRemoteBackend = (remote: string): VaultBackend => {
  const fail = (): never => {
    throw new Error(
      `remote vault "${remote}" needs the agentage cloud backend - not available yet`
    );
  };
  return {
    search: fail,
    read: fail,
    list: fail,
    write: fail,
    edit: fail,
    delete: fail,
    capabilities: () => ({ kind: 'remote', mutate: false, search: 'remote' }),
  };
};
