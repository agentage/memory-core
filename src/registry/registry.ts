import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createLocalBackend } from '../backends/local-backend.js';
import { createRemoteBackend } from '../backends/remote-backend.js';
import type { VaultBackend } from '../backends/vault-backend.js';
import type { McpScope, VaultEntry, VaultsConfig } from '../contract/types.js';

export interface VaultHandle {
  id: string;
  mcp: McpScope[];
  backend: VaultBackend;
}

export interface VaultRegistry {
  list(): VaultHandle[];
  get(id: string): VaultHandle | undefined;
  default(): VaultHandle | undefined;
  surfaced(scope: McpScope): VaultHandle[];
  watch(cb: (next: VaultRegistry) => void): () => void;
  close(): Promise<void>;
}

// `~` and `~/x` expand against $HOME; everything else is left as-is (already absolute
// or relative to cwd).
export const expandPath = (p: string): string => {
  const home = process.env.HOME || homedir();
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return isAbsolute(p) ? p : p;
};

const scopesOf = (entry: VaultEntry): McpScope[] => entry.mcp ?? ['local'];

const isAgentage = (entry: VaultEntry): boolean =>
  !!entry.origin?.some((o) => o.remote === 'agentage');

// Pick the backend for one entry: a `path` -> LocalBackend (git working copy);
// an agentage origin with no path -> the (M4) RemoteBackend. The `mcp` scopes only
// decide whether/where a backend is surfaced, not which backend it is.
const backendFor = (entry: VaultEntry): VaultBackend => {
  if (entry.path) return createLocalBackend({ path: expandPath(entry.path) });
  if (isAgentage(entry)) return createRemoteBackend('agentage');
  return createRemoteBackend(entry.origin?.[0]?.remote ?? 'unknown');
};

// Build the typed vault list from a validated config. Synchronous backend
// construction (LocalBackend init is lazy on first use), so no network at build time.
export const createRegistry = async (config: VaultsConfig): Promise<VaultRegistry> => {
  const handles: VaultHandle[] = Object.entries(config.vaults).map(([id, entry]) => ({
    id,
    mcp: scopesOf(entry),
    backend: backendFor(entry),
  }));
  const byId = new Map(handles.map((h) => [h.id, h]));

  const defaultId =
    config.default ?? (handles.length === 1 ? handles[0]?.id : undefined) ?? undefined;

  return {
    list: () => handles,
    get: (id) => byId.get(id),
    default: () => (defaultId ? byId.get(defaultId) : undefined),
    surfaced: (scope) => handles.filter((h) => h.mcp.includes(scope)),
    // Config hot-reload lands later (memory-core §5); M1 registries are static.
    watch: () => () => {},
    close: async () => {},
  };
};
