import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isValidVaultName } from '../config/config.js';
import type { Origin, VaultEntry, VaultsConfig } from '../contract/types.js';
import { expandPath } from '../registry/registry.js';

// One account-vault candidate: the folder name (its vault id) plus a ready-to-register
// entry in the account shape (path + reserved "agentage" origin + local mcp scope).
export interface DiscoverCandidate {
  name: string;
  entry: VaultEntry;
}

// Injectable filesystem seam so the scan is a pure function in tests. `listDirs` returns
// the immediate subdirectory names of `dir` (empty when the dir is missing/unreadable).
export interface ScanDeps {
  listDirs: (dir: string) => string[];
}

const defaultDeps: ScanDeps = {
  listDirs: (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  },
};

// Enumerate candidate account vaults under `config.discover` roots. Pure - no writes. A
// subfolder becomes a candidate unless its name fails the vault-name rule, is listed in the
// root's `ignore`, or collides with an already-registered vault by resolved path or by name.
// `autosync: false` yields a paused entry (interval 0). Candidates are de-duped across roots.
export const scanDiscoverRoots = (
  config: VaultsConfig,
  deps: ScanDeps = defaultDeps
): DiscoverCandidate[] => {
  const takenNames = new Set<string>();
  const takenPaths = new Set<string>();
  for (const [name, entry] of Object.entries(config.vaults ?? {})) {
    takenNames.add(name);
    if (entry.path) takenPaths.add(resolve(expandPath(entry.path)));
  }

  const out: DiscoverCandidate[] = [];
  for (const root of config.discover ?? []) {
    const base = resolve(expandPath(root.path));
    const ignore = new Set(root.ignore ?? []);
    for (const name of deps.listDirs(base)) {
      if (!isValidVaultName(name) || ignore.has(name) || takenNames.has(name)) continue;
      const path = join(base, name);
      if (takenPaths.has(path)) continue;
      const origin: Origin = {
        remote: 'agentage',
        ...(root.autosync === false ? { interval: 0 } : {}),
      };
      out.push({ name, entry: { path, origin: [origin], mcp: ['local'] } });
      takenNames.add(name);
      takenPaths.add(path);
    }
  }
  return out;
};
