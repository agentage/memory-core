// Per-VAULT git fleet helpers for server hosts, and STRICTLY per-vault: anything
// about the root above them (is it there, writable, the right volume, how full)
// lives in container/root-health.ts. Deliberately user-blind: "which vaults
// belong to whom" is host policy - the host loops its own layout over these
// per-repo operations. All destructive ops are containment-checked.

import { readdir, rm, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { StoreError } from '../../contract/errors.js';
import { createGitRunner } from './git-run.js';

// Immediate child bare repos (<dir>/<name>.git) - one level, host recurses per
// its own layout if it nests (e.g. root/<tenant>/<vault>.git).
export const listVaultDirs = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.endsWith('.git'))
      .map((e) => e.name.slice(0, -'.git'.length))
      .sort();
  } catch {
    return [];
  }
};

// Create the bare repo up front, idempotently - the container's provision hook
// for git vaults, so a new vault exists before anything is ever written to it.
export const ensureBareRepo = async (repoDir: string): Promise<void> =>
  createGitRunner(repoDir).ensureRepo();

// A clone-able bundle of the whole vault (history included) - the export path.
export const bundleRepo = async (repoDir: string): Promise<Buffer | null> => {
  try {
    return await createGitRunner(repoDir).runBuffer(['bundle', 'create', '-', '--all'], {
      maxBufferBytes: 256 * 1024 * 1024,
    });
  } catch {
    return null; // nothing to bundle (empty or missing repo)
  }
};

// Delete one repo (or sidecar dir). Refuses anything not strictly inside
// `within` - the host can never be tricked into deleting outside its root.
export const destroyRepo = async (repoDir: string, opts: { within: string }): Promise<boolean> => {
  const root = resolve(opts.within);
  const target = resolve(repoDir);
  if (!target.startsWith(root + sep) || target === root) {
    throw new StoreError('invalid_path', `refusing to delete outside ${root}`);
  }
  const existed = await stat(target).then(
    () => true,
    () => false
  );
  await rm(target, { recursive: true, force: true });
  return existed;
};
