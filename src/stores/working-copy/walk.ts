// Worktree state for the local world: the human co-owns the files, so content
// can change with no git activity at all. The walk (path -> mtime+size) is the
// change detector - zero spawns, and its digest folds into the version token so
// an uncommitted editor save still moves the version (contract: version changes
// iff content changed).

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export type WorktreeState = Map<string, FileStat>;

// All regular files under the vault, skipping dot-entries at every level
// (.git, .obsidian, .agentage, caches) - the same surface the verbs expose.
export const walkFiles = async (dir: string, prefix = ''): Promise<WorktreeState> => {
  const out: WorktreeState = new Map();
  let dirents;
  try {
    dirents = await readdir(join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) {
      for (const [p, s] of await walkFiles(dir, rel)) out.set(p, s);
    } else if (d.isFile()) {
      try {
        const s = await stat(join(dir, rel));
        out.set(rel, { mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // raced deletion - skip
      }
    }
    // symlinks are neither followed nor listed
  }
  return out;
};

export const digestState = (head: string | null, state: WorktreeState): string | null => {
  if (!head && state.size === 0) return null;
  const h = createHash('sha1').update(head ?? 'no-head');
  for (const p of [...state.keys()].sort()) {
    const s = state.get(p)!;
    h.update(`\n${p}:${s.mtimeMs}:${s.size}`);
  }
  return h.digest('hex');
};

// Paths added, removed, or touched between two walks.
export const diffState = (prev: WorktreeState, next: WorktreeState): string[] => {
  const changed = new Set<string>();
  for (const [p, s] of next) {
    const old = prev.get(p);
    if (!old || old.mtimeMs !== s.mtimeMs || old.size !== s.size) changed.add(p);
  }
  for (const p of prev.keys()) if (!next.has(p)) changed.add(p);
  return [...changed];
};
