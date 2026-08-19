// Vault lifecycle + resolution over the bare layout <root>/<userId>/<vault>.git.
// Access-gated and storage-blind: WHO may touch WHICH vault is decided by the
// host (ResolveAccess is a TYPE here - policy never enters the engine) and
// arrives as a parameter, so this module only enforces a decision against
// storage facts. Nothing here reads the clock, the environment, or a token:
// deletion stamps are supplied by the caller, and live objects come from a cache
// the COMPOSITION ROOT builds with its own cleanup -
//   new ObjectCache<VaultStore>({ max: 256, dispose: (s, key) => detach(s, key) })
// - because whoever creates subscriptions owns tearing them down. The container
// borrows that cache and never configures it.

import { readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObjectCache } from '../cache/object-cache.js';
import { StoreError } from '../contract/errors.js';
import { isSafeSegment } from '../contract/paths.js';
import type { VaultStore } from '../contract/vault-store.js';

// What a caller CLAIMS to be - never trusted, never a path segment.
export interface Principal {
  userId: string;
  vaults?: string[];
}

// What the host DECIDED - the only authority the container reads.
export interface Access {
  userId: string;
  vaults: ReadonlySet<string> | '*';
  canCreate: boolean;
  canDelete: boolean;
}

// Host-side policy (token claims, DB lookup, plan limits); the engine takes the answer only.
export type ResolveAccess = (p: Principal) => Promise<Access>;

export interface VaultContainer {
  list(a: Access): Promise<string[]>;
  create(a: Access, vault: string): Promise<VaultStore>;
  // `stamp` names the tombstone - callers own time, the engine owns no clock.
  remove(a: Access, vault: string, stamp: string): Promise<boolean>;
  open(a: Access, vault: string): Promise<VaultStore>;
}

export interface VaultContainerOptions {
  root: string;
  store: (dir: string) => VaultStore;
  // Store-kind-specific init (bare-git: ensureBareRepo) - the ONLY path that creates.
  provision: (dir: string) => Promise<void>;
  cache: ObjectCache<VaultStore>;
}

const REPO_SUFFIX = '.git';

// Stamps are caller-supplied text that becomes a directory name.
const SAFE_STAMP = /^[A-Za-z0-9:._-]{1,64}$/;

const invalid = (what: string, value: string): StoreError =>
  new StoreError('invalid_path', `invalid ${what}: ${JSON.stringify(value)}`);

const assertSegment = (what: string, value: string): void => {
  if (!isSafeSegment(value)) throw invalid(what, value);
};

const assertStamp = (stamp: string): void => {
  if (!SAFE_STAMP.test(stamp) || stamp.includes('..')) throw invalid('stamp', stamp);
};

// Only an absent directory is "no vault"; EACCES and friends are infrastructure.
const isMissing = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const unavailable = (what: string, err: unknown): StoreError =>
  new StoreError('unavailable', `vault container unavailable: ${what}`, { cause: err });

const dirExists = async (dir: string): Promise<boolean> => {
  try {
    return (await stat(dir)).isDirectory();
  } catch (err) {
    if (isMissing(err)) return false;
    throw unavailable(`stat ${dir}`, err);
  }
};

export const createVaultContainer = (opts: VaultContainerOptions): VaultContainer => {
  const { cache, root } = opts;

  // Every verb goes through here: validate both segments, then gate on the
  // allowlist, then - and only then - compute a path.
  const resolve = (a: Access, vault: string): { key: string; dir: string } => {
    assertSegment('userId', a.userId);
    assertSegment('vault', vault);
    if (a.vaults !== '*' && !a.vaults.has(vault))
      throw new StoreError('forbidden', `no access to vault: ${vault}`);
    return { key: `${a.userId}/${vault}`, dir: join(root, a.userId, `${vault}${REPO_SUFFIX}`) };
  };

  const live = (key: string, dir: string): VaultStore => cache.get(key, () => opts.store(dir));

  return {
    async list(a: Access): Promise<string[]> {
      assertSegment('userId', a.userId);
      let entries;
      try {
        entries = await readdir(join(root, a.userId), { withFileTypes: true });
      } catch (err) {
        if (isMissing(err)) return [];
        throw unavailable(`readdir ${a.userId}`, err);
      }
      return (
        entries
          .filter((e) => e.isDirectory() && e.name.endsWith(REPO_SUFFIX))
          .map((e) => e.name.slice(0, -REPO_SUFFIX.length))
          // Tombstones carry a dot, so the segment allowlist drops them with everything else off-layout.
          .filter((name) => isSafeSegment(name) && (a.vaults === '*' || a.vaults.has(name)))
          .sort()
      );
    },

    async open(a: Access, vault: string): Promise<VaultStore> {
      const { key, dir } = resolve(a, vault);
      // A live object already proves existence; only a cache miss pays for the fs check.
      if (!cache.has(key) && !(await dirExists(dir)))
        throw new StoreError('unknown_vault', `unknown vault: ${vault}`);
      return live(key, dir);
    },

    async create(a: Access, vault: string): Promise<VaultStore> {
      const { key, dir } = resolve(a, vault);
      if (!a.canCreate) throw new StoreError('forbidden', 'not allowed to create vaults');
      if (!(await dirExists(dir))) await opts.provision(dir);
      return live(key, dir);
    },

    async remove(a: Access, vault: string, stamp: string): Promise<boolean> {
      assertStamp(stamp);
      const { key, dir } = resolve(a, vault);
      if (!a.canDelete) throw new StoreError('forbidden', 'not allowed to delete vaults');
      if (!(await dirExists(dir))) return false;
      try {
        await rename(dir, join(root, a.userId, `${vault}.deleted-${stamp}${REPO_SUFFIX}`));
      } catch (err) {
        throw unavailable(`rename ${vault}`, err);
      }
      cache.delete(key); // the live object now points at a tombstone
      return true;
    },
  };
};
