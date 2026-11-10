// The version-keyed snapshot: path list + per-path mtimes, built from git once
// per version and then kept fresh by patches - own writes (zero spawns) and now
// external drift too. This is what removes O(history) work from the request path:
// the full `git log` walk happens once per cold store, and after that only a
// force-push or a change git cannot attribute pays for it again.

import type { GitRunner } from './git-run.js';

export interface Snapshot {
  version: string;
  paths: Set<string>;
  mtimes: Map<string, string>;
}

// One changed path between two versions, and whether it survived the change.
export interface DriftChange {
  path: string;
  deleted: boolean;
}

const ISO_LINE = /^\d{4}-\d\d-\d\dT/;

// path -> newest commit date touching it, over whatever revision range is given
// (`version` = all of history, `old..next` = only the change). `log` is
// newest-first, so the first mention of a path wins.
const datesFrom = async (git: GitRunner, range: string): Promise<Map<string, string>> => {
  const mtimes = new Map<string, string>();
  // -z preserves UTF-8 path bytes and newlines inside filenames. Git emits a
  // separator newline before each path record; strip only that separator.
  const log = await git.tryRun(['log', '-z', '--format=%cI', '--name-only', range]);
  if (!log) return mtimes;
  let date = '';
  for (const record of log.split('\0')) {
    const line = record.startsWith('\n') ? record.slice(1) : record;
    if (!line) continue;
    if (ISO_LINE.test(line)) date = line.trim();
    else if (!mtimes.has(line)) mtimes.set(line, date);
  }
  return mtimes;
};

export const buildSnapshot = async (git: GitRunner, version: string): Promise<Snapshot> => {
  const tree = await git.tryRun(['ls-tree', '-r', '--name-only', '-z', version]);
  const paths = new Set((tree ?? '').split('\0').filter(Boolean));
  return { version, paths, mtimes: await datesFrom(git, version) };
};

// What changed between two versions (bounded by the change, not by history).
// `old` null means the vault went from empty to `next` - everything is new.
// Rename detection stays OFF so a rename reads as the delete + the add it is:
// the snapshot patch needs both halves, and so does an observer.
export const driftChanges = async (
  git: GitRunner,
  old: string | null,
  next: string
): Promise<DriftChange[]> => {
  if (!old) {
    const tree = await git.tryRun(['ls-tree', '-r', '--name-only', '-z', next]);
    return (tree ?? '')
      .split('\0')
      .filter(Boolean)
      .map((path) => ({ path, deleted: false }));
  }
  // -z emits status and raw path as consecutive NUL-terminated records.
  const out = await git.tryRun(['diff', '--name-status', '--no-renames', '-z', old, next]);
  const fields = (out ?? '').split('\0').filter(Boolean);
  const changes: DriftChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i];
    const path = fields[i + 1];
    if (status === undefined || path === undefined) continue;
    changes.push({ path, deleted: status === 'D' });
  }
  return changes;
};

// Move a snapshot to `version` using the diff the drift check already paid for:
// only the changed paths need a new date, so the walk is bounded by the change
// instead of by history. null = cannot patch faithfully; the caller rebuilds.
export const patchSnapshot = async (
  git: GitRunner,
  snap: Snapshot,
  changes: DriftChange[],
  version: string
): Promise<Snapshot | null> => {
  // A non-fast-forward move (force push, reset) can revert paths to content
  // committed OUTSIDE the range, whose dates the range cannot supply.
  if ((await git.tryRun(['merge-base', '--is-ancestor', snap.version, version])) === null)
    return null;
  const dates = await datesFrom(git, `${snap.version}..${version}`);
  const paths = new Set(snap.paths);
  const mtimes = new Map(snap.mtimes);
  // The range log is the authority on WHEN. It is a wider set than the diff: a
  // path edited and then put back has no diff at all, yet it did age.
  for (const [path, date] of dates) mtimes.set(path, date);
  // The diff is the authority on WHAT EXISTS at the new version.
  for (const change of changes) {
    if (change.deleted) {
      paths.delete(change.path);
      mtimes.delete(change.path);
      continue;
    }
    // Changed but unattributed (a merge commit carries no diff of its own):
    // a rebuild knows the date, guessing does not.
    if (!dates.has(change.path)) return null;
    paths.add(change.path);
  }
  return { version, paths, mtimes };
};
