import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractSuite } from '../../src/conformance/contract-suite.js';
import { securitySuite } from '../../src/conformance/security-suite.js';
import { createWorkingCopyGitStore } from '../../src/index.js';

let currentDir = '';
const makeDir = async (): Promise<string> => {
  currentDir = await mkdtemp(join(tmpdir(), 'wc-store-'));
  return currentDir;
};

contractSuite({
  name: 'working-copy-store',
  make: async () => createWorkingCopyGitStore(await makeDir()),
  // The local out-of-band writer is the human: a plain file save, no git at all.
  mutateExternally: async () => {
    await writeFile(join(currentDir, 'pushed.md'), 'saved from an editor', 'utf8');
    return ['pushed.md'];
  },
});

securitySuite({
  name: 'working-copy-store',
  make: async () => createWorkingCopyGitStore(await makeDir()),
});

describe('working-copy-store: files-first behavior', () => {
  it('an uncommitted editor save is immediately readable and searchable', async () => {
    const dir = await makeDir();
    const s = createWorkingCopyGitStore(dir);
    await s.write({ path: 'seed.md', body: 'committed' });
    await writeFile(join(dir, 'draft.md'), 'fresh obsidian thought', 'utf8');
    expect((await s.read('draft.md'))!.body).toBe('fresh obsidian thought');
    const hits = await s.search({ query: 'obsidian', limit: 10 });
    expect(hits.results.map((r) => r.path)).toEqual(['draft.md']);
  });

  it('store writes are plain markdown on disk and git-committed', async () => {
    const dir = await makeDir();
    const s = createWorkingCopyGitStore(dir);
    await s.write({ path: 'notes/plain.md', body: 'owned by the user', frontmatter: { k: 1 } });
    const onDisk = await readFile(join(dir, 'notes/plain.md'), 'utf8');
    expect(onDisk).toContain('owned by the user');
    expect(onDisk).toContain('k: 1');
    const log = await new Promise<string>((resolve, reject) =>
      execFile('git', ['-C', dir, 'log', '--format=%s'], (e, so) => (e ? reject(e) : resolve(so)))
    );
    expect(log).toContain('write: notes/plain.md');
  });

  it('a fresh instance sees another instance state (durable on disk)', async () => {
    const dir = await makeDir();
    const a = createWorkingCopyGitStore(dir);
    await a.write({ path: 'keep.md', body: 'still here' });
    const b = createWorkingCopyGitStore(dir);
    expect((await b.read('keep.md'))!.body).toBe('still here');
  });

  it('zero spawns on the read side: read, list, search, version', async () => {
    const dir = await makeDir();
    const spawns: string[][] = [];
    const s = createWorkingCopyGitStore(dir, { onSpawn: (a) => spawns.push(a) });
    await s.write({ path: 'a.md', body: 'hello' });
    await s.write({ path: 'b/c.md', body: 'world' });
    spawns.length = 0;
    await s.read('a.md');
    await s.list({});
    await s.search({ query: 'hello', limit: 10 });
    await s.version();
    expect(spawns).toHaveLength(0);
  });

  it('cleans up temp vaults', async () => {
    await rm(currentDir, { recursive: true, force: true });
  });
});
