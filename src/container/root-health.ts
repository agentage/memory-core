// Root-level FACTS about the store root: is it there, may we write it, is it the
// right volume (marker), how much disk is left. Everything above one vault, in
// one place, so a host never opens `node:fs` to answer its own /health.
//
// It NEVER throws: a vanished root is a fact to report (all-false + zeros), not
// an exception that fails the probe that asked. And the default is CHEAP - a
// permission check, not a write - because health endpoints poll forever; the
// honest write probe (bits can lie: full disk, read-only remount) is opt-in.

import { constants } from 'node:fs';
import { access, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RootFacts {
  reachable: boolean;
  writable: boolean;
  // null = no marker was asked for; false = asked for and not found.
  markerPresent: boolean | null;
  diskFreeBytes: number;
  diskTotalBytes: number;
}

export interface CheckRootOptions {
  // A file the volume must carry - catches a writable-but-WRONG root.
  markerFile?: string;
  // true = write+unlink a probe file; default = access(R_OK|W_OK).
  probeWrite?: boolean;
}

const can = async (path: string, mode: number): Promise<boolean> => {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
};

const isReadableDir = async (dir: string): Promise<boolean> => {
  try {
    return (await stat(dir)).isDirectory() && (await can(dir, constants.R_OK));
  } catch {
    return false;
  }
};

const probeWritable = async (dir: string): Promise<boolean> => {
  const at = join(dir, `.probe-${process.pid}-${Date.now()}`);
  try {
    await writeFile(at, 'ok', 'utf8');
    await unlink(at);
    return true;
  } catch {
    return false;
  }
};

// bavail (not bfree) is what an unprivileged writer may actually use.
const disk = async (dir: string): Promise<{ free: number; total: number }> => {
  try {
    const s = await statfs(dir);
    return { free: s.bsize * s.bavail, total: s.bsize * s.blocks };
  } catch {
    return { free: 0, total: 0 };
  }
};

export const checkRoot = async (root: string, opts: CheckRootOptions = {}): Promise<RootFacts> => {
  const reachable = await isReadableDir(root);
  const [writable, markerPresent, { free, total }] = await Promise.all([
    // An unreachable root is never "writable", and never gets probed.
    reachable
      ? opts.probeWrite
        ? probeWritable(root)
        : can(root, constants.R_OK | constants.W_OK)
      : Promise.resolve(false),
    opts.markerFile ? can(join(root, opts.markerFile), constants.F_OK) : Promise.resolve(null),
    disk(root),
  ]);
  return { reachable, writable, markerPresent, diskFreeBytes: free, diskTotalBytes: total };
};

// The 1.x shape - the two booleans a startup sentinel and /health always asked
// for - now a projection of the fact set, write-probing as it always did.
export const checkRootWritable = async (
  dir: string
): Promise<{ reachable: boolean; writable: boolean }> => {
  const { reachable, writable } = await checkRoot(dir, { probeWrite: true });
  return { reachable, writable };
};
