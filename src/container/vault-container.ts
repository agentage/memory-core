// Vault lifecycle + resolution over the bare layout <root>/<userId>/<vault>.git.
// Access-gated and storage-blind: WHO may touch WHICH vault is decided by the
// host (ResolveAccess is a TYPE here - policy never enters the engine) and
// arrives as a parameter, so this module only enforces a decision against
// storage facts. Nothing here reads the clock, the environment, or a token:
// deletion stamps are supplied by the caller, and live objects come from a cache
// the COMPOSITION ROOT builds with its own cleanup -
//   new ObjectCache<VaultStore>({ max: 256, dispose: (s, key) => detach(s, key) })
// - because whoever creates subscriptions owns tearing them down. The container
// borrows that cache and never configures it. Paths are never joined here: every
// one comes from container/layout.ts, which allowlists the name first.

import { readdir, rename, stat } from 'node:fs/promises';
import type { ObjectCache } from '../cache/object-cache.js';
import { StoreError } from '../contract/errors.js';
import { isSafeSegment } from '../contract/paths.js';
import type { VaultStore } from '../contract/vault-store.js';
import { bundleRepo, destroyRepo } from '../stores/bare-git/git-admin.js';
import {
  assertSegment,
  assertStamp,
  REPO_SUFFIX,
  tombstoneRepoDir,
  userDir,
  vaultRepoDir,
} from './layout.js';

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
  // A clone-able git bundle of one vault, history included - the export path.
  bundle(a: Access, vault: string): Promise<Buffer | null>;
  // Erases what ONE user has STORED: every vault they own, tombstones included,
  // gone for good. Not the user - accounts live in the auth service, not here.
  destroyUserData(a: Access, userId: string): Promise<boolean>;
}

// What ROUTING needs - the lifecycle verbs only. Export and data erasure are
// not routing concerns, so a router (or a double standing in for one) never sees
// them, and adding a verb to the container never widens what the router demands.
export type RoutedContainer = Pick<VaultContainer, 'list' | 'open' | 'create' | 'remove'>;

export interface VaultContainerOptions {
  root: string;
  store: (dir: string) => VaultStore;
  // Store-kind-specific init (bare-git: ensureBareRepo) - the ONLY path that creates.
  provision: (dir: string) => Promise<void>;
  cache: ObjectCache<VaultStore>;
}

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
    return { key: `${a.userId}/${vault}`, dir: vaultRepoDir(root, a.userId, vault) };
  };

  const live = (key: string, dir: string): VaultStore => cache.get(key, () => opts.store(dir));

  // Every repo dir a user owns, tombstones included - the raw layout, ungated.
  const repoSlugs = async (userId: string): Promise<string[]> => {
    const dir = userDir(root, userId); // a bad name never reaches the fs, nor the catch
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && e.name.endsWith(REPO_SUFFIX))
        .map((e) => e.name.slice(0, -REPO_SUFFIX.length));
    } catch (err) {
      if (isMissing(err)) return [];
      throw unavailable(`readdir ${userId}`, err);
    }
  };

  return {
    async list(a: Access): Promise<string[]> {
      return (
        (await repoSlugs(a.userId))
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
        await rename(dir, tombstoneRepoDir(root, a.userId, vault, stamp));
      } catch (err) {
        throw unavailable(`rename ${vault}`, err);
      }
      cache.delete(key); // the live object now points at a tombstone
      return true;
    },

    // Gated exactly like open(), but absence is an empty answer rather than a
    // refusal: null = nothing to export (no repo, or no commits yet).
    async bundle(a: Access, vault: string): Promise<Buffer | null> {
      return bundleRepo(resolve(a, vault).dir);
    },

    // Only the user's own data, and only with the delete grant - there is no
    // cross-user sweep, and no stamp: this is the erase, not the tombstone.
    async destroyUserData(a: Access, userId: string): Promise<boolean> {
      assertSegment('userId', a.userId);
      assertSegment('userId', userId);
      if (a.userId !== userId) throw new StoreError('forbidden', `no access to user: ${userId}`);
      if (!a.canDelete) throw new StoreError('forbidden', 'not allowed to delete vaults');
      const dir = userDir(root, userId);
      for (const slug of await repoSlugs(userId)) cache.delete(`${userId}/${slug}`);
      try {
        return await destroyRepo(dir, { within: root });
      } catch (err) {
        if (err instanceof StoreError) throw err;
        throw unavailable(`destroy ${userId}`, err);
      }
    },
  };
};
