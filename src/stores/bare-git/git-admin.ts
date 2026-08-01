// Per-VAULT git fleet helpers for server hosts. Deliberately user-blind: "which
// vaults belong to whom" is host policy - the host loops its own layout over
// these per-repo operations. All destructive ops are containment-checked.

import { execFile } from 'node:child_process';
import { readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { StoreError } from '../../contract/errors.js';

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
export const bundleRepo = (repoDir: string): Promise<Buffer | null> =>
  new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['bundle', 'create', '-', '--all'],
      {
        env: { ...process.env, GIT_DIR: repoDir },
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
      },
      (err, stdout) => (err ? resolvePromise(null) : resolvePromise(stdout as unknown as Buffer))
    );
    void reject;
  });

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
