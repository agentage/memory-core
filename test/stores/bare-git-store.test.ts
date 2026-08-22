import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractSuite } from '../../src/conformance/contract-suite.js';
import { securitySuite } from '../../src/conformance/security-suite.js';
import { createBareGitStore, validateBareRepoTree } from '../../src/index.js';
import { externalCommit, runGit } from './external-git.js';

let currentRepo = '';
let externalTick = 0;
const makeRepoDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'bare-git-store-'));
  currentRepo = join(dir, 'vault.git');
  externalTick = 0; // each repo replays the same push sequence from the start
  return currentRepo;
};

// Cycles add -> modify -> delete, so the kit's external-change proofs see every
// kind of drift a real push carries, not just an append.
const mutateExternally = async (): Promise<string[]> => {
  const n = externalTick++;
  if (n % 3 === 1) {
    await externalCommit(currentRepo, [
      { path: `pushed-${n - 1}.md`, content: `rewritten by push ${n}` },
    ]);
    return [`pushed-${n - 1}.md`];
  }
  if (n % 3 === 2) {
    await externalCommit(currentRepo, [{ path: `pushed-${n - 2}.md`, remove: true }]);
    return [`pushed-${n - 2}.md`];
  }
  await externalCommit(currentRepo, [
    { path: `pushed-${n}.md`, content: `pushed ${n} from outside` },
  ]);
  return [`pushed-${n}.md`];
};

contractSuite({
  name: 'bare-git-store',
  make: async () => createBareGitStore(await makeRepoDir()),
  mutateExternally,
  // A second instance on the same bare repo - what a restart sees.
  reopen: () => createBareGitStore(currentRepo),
  // A git spawn IS this store's round trip, so the kit can price its own verbs.
  makeCounted: async () => {
    let spawns = 0;
    const store = createBareGitStore(await makeRepoDir(), { onSpawn: () => spawns++ });
    return {
      store,
      trips: () => spawns,
      reset: () => {
        spawns = 0;
      },
    };
  },
});

securitySuite({
  name: 'bare-git-store',
  make: async () => createBareGitStore(await makeRepoDir()),
});

describe('bare-git-store: durability + concurrency', () => {
  it('a fresh instance reads what another instance wrote (survives restart)', async () => {
    const repo = await makeRepoDir();
    const a = createBareGitStore(repo);
    await a.write({ path: 'keep.md', body: 'durable', frontmatter: { k: 1 } });
    const b = createBareGitStore(repo);
    expect(await b.read('keep.md')).toMatchObject({ body: 'durable', frontmatter: { k: 1 } });
    expect(await b.version()).toBe(await a.version());
  });

  it('two instances writing concurrently lose no update (CAS)', async () => {
    const repo = await makeRepoDir();
    const a = createBareGitStore(repo);
    const b = createBareGitStore(repo);
    await a.write({ path: 'seed.md', body: 's' });
    await Promise.all([
      a.write({ path: 'from-a.md', body: 'a' }),
      b.write({ path: 'from-b.md', body: 'b' }),
    ]);
    const fresh = createBareGitStore(repo);
    expect((await fresh.read('from-a.md'))!.body).toBe('a');
    expect((await fresh.read('from-b.md'))!.body).toBe('b');
  });

  it('delete keeps history: the file is gone but the repo is versioned', async () => {
    const repo = await makeRepoDir();
    const s = createBareGitStore(repo);
    await s.write({ path: 'gone.md', body: 'recoverable' });
    await s.delete('gone.md');
    expect(await s.read('gone.md')).toBeNull();
    const log = await runGit(repo, ['log', '--format=%s']);
    expect(log).toContain('delete: gone.md');
    expect(log).toContain('write: gone.md');
  });
});

describe('bare-git-store: snapshot consistency', () => {
  it('tag-filtered list reads the snapshot ref, not a HEAD that moved mid-call', async () => {
    const repo = await makeRepoDir();
    const seed = createBareGitStore(repo);
    await seed.write({ path: 'b.md', body: 'beta', frontmatter: { tags: ['keep'] } });
    const v1 = (await seed.write({ path: 'a.md', body: 'alpha', frontmatter: { tags: ['keep'] } }))
      .rev;
    const v2 = (await seed.write({ path: 'a.md', body: 'alpha', frontmatter: { tags: ['gone'] } }))
      .rev;
    await runGit(repo, ['update-ref', 'refs/heads/main', v1]); // the store below boots at v1

    // Fire the race once: the ref jumps v1 -> v2 after the snapshot, before the doc read.
    let armed = false;
    const s = createBareGitStore(repo, {
      onSpawn: (args) => {
        if (!armed || args[0] !== 'cat-file') return;
        armed = false;
        execFileSync('git', ['update-ref', 'refs/heads/main', v2], {
          env: { ...process.env, GIT_DIR: repo },
        });
      },
    });
    await s.list({}); // warm the snapshot at v1
    armed = true;

    const res = await s.list({ tags: ['keep'] });
    expect(res.entries.map((e) => e.path).sort()).toEqual(['a.md', 'b.md']);
    expect(await runGit(repo, ['rev-parse', 'refs/heads/main'])).toContain(v2); // race did fire
  });
});

describe('bare-git-store: spawn budget', () => {
  it('warm verbs hold the pinned budget: read<=1, readMany<=1, search<=2, list=0, version=0', async () => {
    const repo = await makeRepoDir();
    const spawns: string[][] = [];
    const s = createBareGitStore(repo, { onSpawn: (a) => spawns.push(a) });
    await s.write({ path: 'a.md', body: 'hello world' });
    await s.write({ path: 'sub/b.md', body: 'hello again' });
    await s.list({}); // warm the snapshot

    spawns.length = 0;
    await s.version();
    expect(spawns).toHaveLength(0);

    spawns.length = 0;
    await s.read('a.md');
    expect(spawns.length).toBeLessThanOrEqual(1);

    // The whole point: N docs cost what ONE read costs, not N times it.
    spawns.length = 0;
    const many = await s.readMany(['a.md', 'sub/b.md', 'nope.md', 'a.md']);
    expect(many.map((v) => v?.path ?? null)).toEqual(['a.md', 'sub/b.md', null, 'a.md']);
    expect(spawns.map((a) => a[0])).toEqual(['cat-file']);

    spawns.length = 0;
    await s.search({ query: 'hello', limit: 10 });
    expect(spawns.length).toBeLessThanOrEqual(2);

    spawns.length = 0;
    await s.list({});
    expect(spawns).toHaveLength(0);

    // Two spawns once per version (stats + the commit date), then nothing -
    // a page of vault cards costs one describe, not one per card.
    spawns.length = 0;
    await s.describe();
    const first = spawns.length;
    spawns.length = 0;
    await s.describe();
    expect(spawns).toHaveLength(0);
    expect(first).toBeLessThanOrEqual(2);
  });

  // Pinned, not endorsed. The write path is 7 spawns: read the doc, hash the
  // blob, read-tree/update-index/write-tree, commit-tree, CAS update-ref. The
  // tree trio is ~45% of the wall clock, and every way to shorten it either
  // re-implements git's tree encoding or hands the ref update to fast-import -
  // neither is provably identical, so the number is a gate, not a target.
  it('the write path costs 7 spawns - a ceiling, so any change is visible', async () => {
    const repo = await makeRepoDir();
    const spawns: string[][] = [];
    const s = createBareGitStore(repo, { onSpawn: (a) => spawns.push(a) });
    await s.write({ path: 'seed.md', body: 'seed' });

    spawns.length = 0;
    await s.write({ path: 'work/deep/note.md', body: 'nested' });
    expect(spawns.map((a) => a[0])).toEqual([
      'cat-file',
      'hash-object',
      'read-tree',
      'update-index',
      'write-tree',
      'commit-tree',
      'update-ref',
    ]);

    // A no-op write stops before the commit machinery entirely.
    spawns.length = 0;
    await s.write({ path: 'work/deep/note.md', body: 'nested' });
    expect(spawns.map((a) => a[0])).toEqual(['cat-file']);
  });
});

describe('validateBareRepoTree', () => {
  it('flags symlinks, reserved paths, and oversized blobs; clean tree passes', async () => {
    const repo = await makeRepoDir();
    const s = createBareGitStore(repo);
    await s.write({ path: 'fine.md', body: 'ok' });
    expect(await validateBareRepoTree(repo)).toEqual([]);

    await externalCommit(repo, [{ path: 'link.md', content: 'target', mode: '120000' }]);
    await externalCommit(repo, [{ path: '.agentage/hooks.json', content: '{}' }]);
    const violations = await validateBareRepoTree(repo, { maxBytes: 1 });
    const byPath = new Map(violations.map((v) => [v.path, v.kind]));
    expect(byPath.get('link.md')).toBe('non-file-mode');
    expect(byPath.get('.agentage/hooks.json')).toBe('unsafe-path');
    expect(byPath.get('fine.md')).toBe('oversized'); // 2 bytes > maxBytes 1
  });
});
