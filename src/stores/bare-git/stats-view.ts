// First real derived view: aggregate vault stats with true byte sizes. Closes
// over the repo (needs `ls-tree -l`, which the reader contract doesn't expose) -
// the intended pattern for store-specific views.

import type { DerivedView } from '../../contract/derived.js';
import { createGitRunner, type GitRunner } from './git-run.js';

export interface VaultStats {
  files: number;
  folders: number;
  sizeBytes: number;
  empty: boolean;
}

const EMPTY: VaultStats = { files: 0, folders: 0, sizeBytes: 0, empty: true };

// A repo dir (standalone callers) or a live runner (the store passes its own, so
// the spawn stays inside the store's onSpawn accounting). Either way the spawn
// runs in the runner's hermetic environment.
type GitTarget = string | GitRunner;

const runnerOf = (target: GitTarget): GitRunner =>
  typeof target === 'string' ? createGitRunner(target) : target;

// One `ls-tree -l` pass over the version: blobs carry their exact stored size,
// trees are the folders. Shared by the cached view and describe().
export const computeVaultStats = async (
  target: GitTarget,
  version: string | null
): Promise<VaultStats> => {
  if (!version) return EMPTY;
  const stdout = await runnerOf(target).tryRun(['ls-tree', '-r', '-t', '-l', version]);
  if (stdout === null) return EMPTY;
  let files = 0;
  let folders = 0;
  let sizeBytes = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [, type, , size] = line.slice(0, line.indexOf('\t')).trim().split(/\s+/);
    if (type === 'blob') {
      files++;
      sizeBytes += Number(size) || 0;
    } else if (type === 'tree') {
      folders++;
    }
  }
  return { files, folders, sizeBytes, empty: files === 0 };
};

export const createStatsView = (repoDir: string): DerivedView<VaultStats> => ({
  name: 'stats',
  policy: { recompute: 'on-change' },
  compute: (_reader, version) => computeVaultStats(repoDir, version),
});
