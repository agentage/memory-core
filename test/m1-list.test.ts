import { describe, expect, it } from 'vitest';
import { createLocalBackend } from '../src/backends/local-backend.js';
import type { TreeFolder } from '../src/contract/types.js';
import { tmpVault } from './fixtures/index.js';

// TC4 - list tree + truncation. M1-R5.
describe('TC4 list', () => {
  const seed = {
    'readme.md': 'top',
    'work/a.md': 'a',
    'work/b.md': 'b',
    'work/tasks/t1.md': 't1',
    'personal/p.md': 'p',
  };

  it('returns the depth-2 tree, folders first, with counts', async () => {
    const b = createLocalBackend({ path: tmpVault(seed) });
    const r = await b.list({});
    expect(r.files).toBe(5);
    const kinds = r.entries.map((e) => `${e.type}:${e.path}`);
    // folders (personal, work) sorted first, then the loose file
    expect(kinds).toEqual(['folder:personal', 'folder:work', 'file:readme.md']);
    const work = r.entries.find((e) => e.path === 'work') as TreeFolder;
    expect(work.files).toBe(3);
    expect(work.entries?.map((e) => e.path).sort()).toEqual([
      'work/a.md',
      'work/b.md',
      'work/tasks',
    ]);
  });

  it('depth 1 lists direct children only (folders not expanded)', async () => {
    const b = createLocalBackend({ path: tmpVault(seed) });
    const r = await b.list({ depth: 1 });
    const work = r.entries.find((e) => e.path === 'work') as TreeFolder;
    expect(work.entries).toBeUndefined();
    expect(work.files).toBe(3);
  });

  it('scopes to a folder', async () => {
    const b = createLocalBackend({ path: tmpVault(seed) });
    const r = await b.list({ folder: 'work' });
    expect(r.folder).toBe('work');
    expect(r.files).toBe(3);
    expect(r.entries.map((e) => e.path)).toContain('work/tasks');
  });

  it('flags truncated when a folder exceeds the per-folder limit', async () => {
    const b = createLocalBackend({
      path: tmpVault({ 'a.md': '1', 'b.md': '2', 'c.md': '3' }),
      listLimits: { folderEntries: 2, totalEntries: 500 },
    });
    const r = await b.list({});
    expect(r.truncated).toBe(true);
    expect(r.entries.length).toBe(2);
  });

  it('filters by tag', async () => {
    const b = createLocalBackend({
      path: tmpVault({
        'a.md': '---\ntags: [keep]\n---\nx',
        'b.md': 'no tags',
      }),
    });
    const r = await b.list({ tags: ['keep'] });
    expect(r.files).toBe(1);
    expect(r.entries.map((e) => e.path)).toEqual(['a.md']);
  });

  it('returns an empty tree for an empty vault', async () => {
    const r = await createLocalBackend({ path: tmpVault() }).list({});
    expect(r).toEqual({ folder: '', entries: [], truncated: false, files: 0 });
  });
});
