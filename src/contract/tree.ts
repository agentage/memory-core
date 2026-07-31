// List semantics defined ONCE: the depth-limited folder tree with per-folder and
// total-budget truncation (tree --filelimit semantics). Stores supply the flat
// path list + mtimes; the shape logic never diverges between implementations.

import { titleFromPath } from './memory-doc.js';
import type { ListResult, TreeFile, TreeFolder } from './types.js';

export interface ListLimits {
  folderEntries: number;
  totalEntries: number;
}

export const DEFAULT_LIST_LIMITS: ListLimits = { folderEntries: 100, totalEntries: 500 };
export const DEFAULT_LIST_DEPTH = 2;

// "work/" and "work" both mean the folder work; '' means the vault root.
export const normalizeFolder = (folder?: string): string =>
  (folder ?? '').trim().replace(/\/+$/, '');

// In-memory trie of the flat path list, scoped to `folder`. Folders are implicit
// (no empty-dir case), so every node holds >= 1 file recursively.
interface DirNode {
  files: string[];
  dirs: Map<string, DirNode>;
  count: number;
}

const dirTree = (paths: string[], folder: string): DirNode => {
  const make = (): DirNode => ({ files: [], dirs: new Map(), count: 0 });
  const root = make();
  for (const full of paths) {
    const segs = (folder ? full.slice(folder.length + 1) : full).split('/');
    let node = root;
    node.count++;
    for (const seg of segs.slice(0, -1)) {
      let child = node.dirs.get(seg);
      if (!child) {
        child = make();
        node.dirs.set(seg, child);
      }
      node = child;
      node.count++;
    }
    node.files.push(full);
  }
  return root;
};

export const buildTree = (
  paths: string[],
  folder: string,
  depth: number,
  mtimes: Map<string, string>,
  limits: ListLimits = DEFAULT_LIST_LIMITS
): ListResult => {
  const result: ListResult = { folder, entries: [], truncated: false, files: 0 };
  if (!paths.length) return result;

  const root = dirTree(paths, folder);
  result.files = root.count;

  const fileEntry = (full: string): TreeFile => ({
    type: 'file',
    path: full,
    title: titleFromPath(full),
    updated: mtimes.get(full) ?? '',
  });
  const byName = (a: string, b: string): number => a.localeCompare(b);
  const directOf = (node: DirNode, base: string) => ({
    dirs: [...node.dirs.entries()]
      .sort(([a], [b]) => byName(a, b))
      .map(([name, child]) => ({ path: base ? `${base}/${name}` : name, node: child })),
    files: [...node.files].sort(byName),
  });

  const top = directOf(root, folder);
  const topTotal = top.dirs.length + top.files.length;
  if (topTotal > limits.folderEntries) result.truncated = true;
  const topDirs = top.dirs.slice(0, limits.folderEntries);
  const topFiles = top.files.slice(0, Math.max(0, limits.folderEntries - topDirs.length));
  let used = topDirs.length + topFiles.length;

  for (const d of topDirs) {
    const entry: TreeFolder = { type: 'folder', path: d.path, files: d.node.count };
    if (depth >= 2) {
      const inner = directOf(d.node, d.path);
      const innerTotal = inner.dirs.length + inner.files.length;
      if (innerTotal > limits.folderEntries || used + innerTotal > limits.totalEntries) {
        entry.truncated = true;
        result.truncated = true;
      } else {
        entry.entries = [
          ...inner.dirs.map((s) => ({
            type: 'folder' as const,
            path: s.path,
            files: s.node.count,
          })),
          ...inner.files.map(fileEntry),
        ];
        used += innerTotal;
      }
    }
    result.entries.push(entry);
  }
  for (const f of topFiles) result.entries.push(fileEntry(f));
  return result;
};
