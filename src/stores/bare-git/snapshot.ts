// The version-keyed snapshot: path list + per-path mtimes, built from git once
// per version and then kept fresh by own-write patches (zero spawns). This is
// what removes O(history) work from the request path - the full `git log` walk
// happens once per cold store or after an external change, never per query.

import type { GitRunner } from './git-run.js';

export interface Snapshot {
  version: string;
  paths: Set<string>;
  mtimes: Map<string, string>;
}

const ISO_LINE = /^\d{4}-\d\d-\d\dT/;

export const buildSnapshot = async (git: GitRunner, version: string): Promise<Snapshot> => {
  const tree = await git.tryRun(['ls-tree', '-r', '--name-only', version]);
  const paths = new Set((tree ?? '').split('\n').filter(Boolean));
  // One history pass: path -> most-recent commit date (log is newest-first).
  const mtimes = new Map<string, string>();
  const log = await git.tryRun(['log', '--format=%cI', '--name-only', version]);
  if (log) {
    let date = '';
    for (const line of log.split('\n')) {
      if (line === '') continue;
      if (ISO_LINE.test(line)) date = line.trim();
      else if (!mtimes.has(line)) mtimes.set(line, date);
    }
  }
  return { version, paths, mtimes };
};

// Paths whose content differs between two versions (bounded by the change, not
// history). `old` null means the vault went from empty to `next` - everything.
export const driftPaths = async (
  git: GitRunner,
  old: string | null,
  next: string
): Promise<string[]> => {
  const out = old
    ? await git.tryRun(['diff', '--name-only', old, next])
    : await git.tryRun(['ls-tree', '-r', '--name-only', next]);
  return (out ?? '').split('\n').filter(Boolean);
};
