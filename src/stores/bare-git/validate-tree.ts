// Pushed content bypasses the write-path guards entirely (a `git push` lands via
// receive-pack), so the tree itself must be checkable: sync runs this pre-receive
// to reject a push carrying symlinks, unsafe paths, or oversized blobs.

import { safePath } from '../../contract/paths.js';
import { MAX_DOC_BYTES } from '../../contract/read-budget.js';
import { createGitRunner } from './git-run.js';

export interface TreeViolation {
  path: string;
  kind: 'unsafe-path' | 'non-file-mode' | 'oversized';
  detail: string;
}

export const validateBareRepoTree = async (
  repoDir: string,
  opts: { ref?: string; maxBytes?: number } = {}
): Promise<TreeViolation[]> => {
  const ref = opts.ref ?? 'refs/heads/main';
  const maxBytes = opts.maxBytes ?? MAX_DOC_BYTES;
  const stdout = await createGitRunner(repoDir).run(['ls-tree', '-r', '-l', ref]);
  const violations: TreeViolation[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode, type, , size] = line.slice(0, tab).trim().split(/\s+/);
    const path = line.slice(tab + 1);
    if (mode !== '100644' || type !== 'blob') {
      violations.push({ path, kind: 'non-file-mode', detail: `mode ${mode} type ${type}` });
      continue;
    }
    // `.agentage/` in a push is flagged too: system files enter via the
    // system API, never via a client push (policy owner decides handling).
    if (!safePath(path)) {
      violations.push({ path, kind: 'unsafe-path', detail: 'fails safePath' });
      continue;
    }
    if (Number(size) > maxBytes) {
      violations.push({ path, kind: 'oversized', detail: `${size} bytes > ${maxBytes}` });
    }
  }
  return violations;
};
