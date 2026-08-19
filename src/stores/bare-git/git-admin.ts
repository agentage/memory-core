// Git fleet helpers for server hosts, in two layers. The per-repo ops below are
// layout-blind (point them at any dir); the tenant admin surface at the bottom
// owns ONE layout - <root>/<userId>/<vault>.git - and is the lifecycle companion
// a multi-tenant host needs. All destructive ops are containment-checked.

import type { Dirent } from 'node:fs';
import { readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { StoreError } from '../../contract/errors.js';
import { isSafeSegment } from '../../contract/paths.js';
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

// Startup sentinel + /health probe: the root exists and is writable.
export const checkRootWritable = async (
  dir: string
): Promise<{ reachable: boolean; writable: boolean }> => {
  try {
    await readdir(dir);
  } catch {
    return { reachable: false, writable: false };
  }
  const probe = join(dir, `.probe-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe);
    return { reachable: true, writable: true };
  } catch {
    return { reachable: true, writable: false };
  }
};

// ---------------------------------------------------------------------------
// Tenant admin surface - the <root>/<userId>/<vault>.git layout.
// ---------------------------------------------------------------------------

// Timestamps a caller may stamp a tombstone with (ISO or epoch), separator-free.
const SAFE_STAMP = /^[A-Za-z0-9._:+-]{1,64}$/;

const assertSegment = (label: string, value: string): void => {
  if (!isSafeSegment(value)) {
    throw new StoreError('invalid_path', `invalid ${label}: ${JSON.stringify(value)}`);
  }
};

// Paths are built from allowlisted segments and then re-checked against the root:
// a target resolving outside it can only be a bug, never a caller's business.
const under = (root: string, ...segments: string[]): string => {
  const base = resolve(root);
  const target = resolve(join(root, ...segments));
  if (target === base || !target.startsWith(base + sep)) {
    throw new StoreError('invalid_path', `refusing to touch outside ${base}`);
  }
  return target;
};

const dirExists = (dir: string): Promise<boolean> =>
  stat(dir).then(
    () => true,
    () => false
  );

// Existence via a plain readdir, NEVER a `git init`: a read path must 404 a
// missing vault instead of lazily materializing it.
export const vaultExists = async (
  root: string,
  userId: string,
  vault: string
): Promise<boolean> => {
  if (!isSafeSegment(userId) || !isSafeSegment(vault)) return false;
  try {
    return (await readdir(join(root, userId))).includes(`${vault}.git`);
  } catch {
    return false;
  }
};

// The vault slugs a user owns, sorted. The allowlist filter is load-bearing: it
// is what keeps tombstoned repos (dots in the name) out of every listing.
export const listVaults = async (root: string, userId: string): Promise<string[]> => {
  if (!isSafeSegment(userId)) return [];
  const entries = await readdir(join(root, userId), { withFileTypes: true }).catch(
    (): Dirent[] => []
  );
  return entries
    .filter((e) => e.isDirectory() && e.name.endsWith('.git'))
    .map((e) => e.name.slice(0, -'.git'.length))
    .filter((v) => isSafeSegment(v))
    .sort();
};

// Tombstone rather than remove: renaming to <vault>.deleted-<stamp>.git stops it
// matching listVaults/vaultExists (the dots fail the allowlist) while every byte
// stays on disk and in the backups - restoring is a rename back, and the name is
// free to re-create immediately. `stamp` is the caller's: no clock in the engine.
export const deleteVault = async (
  root: string,
  userId: string,
  vault: string,
  stamp: string
): Promise<{ deleted: boolean }> => {
  assertSegment('userId', userId);
  assertSegment('vault', vault);
  if (!SAFE_STAMP.test(stamp)) {
    throw new StoreError('invalid_path', `invalid stamp: ${JSON.stringify(stamp)}`);
  }
  const gitDir = under(root, userId, `${vault}.git`);
  const tombstone = under(root, userId, `${vault}.deleted-${stamp}.git`);
  if (!(await dirExists(gitDir))) return { deleted: false };
  await rename(gitDir, tombstone);
  return { deleted: true };
};

// Erase every repo a user owns, tombstones included, by removing their dir.
// Idempotent; the allowlisted segment is what keeps the sweep inside the root.
export const deleteUser = async (root: string, userId: string): Promise<{ deleted: boolean }> => {
  assertSegment('userId', userId);
  const userDir = under(root, userId);
  const existed = await dirExists(userDir);
  await rm(userDir, { recursive: true, force: true });
  return { deleted: existed };
};
