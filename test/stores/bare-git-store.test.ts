import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractSuite } from '../../src/conformance/contract-suite.js';
import { securitySuite } from '../../src/conformance/security-suite.js';
import { createBareGitStore, validateBareRepoTree } from '../../src/index.js';

const runGit = (
  dir: string,
  args: string[],
  input?: string,
  extraEnv: Record<string, string> = {}
): Promise<string> =>
  new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GIT_DIR: dir,
      GIT_AUTHOR_NAME: 'ext',
      GIT_AUTHOR_EMAIL: 'ext@test',
      GIT_COMMITTER_NAME: 'ext',
      GIT_COMMITTER_EMAIL: 'ext@test',
      ...extraEnv,
    };
    const child = execFile('git', args, { env }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
    if (input !== undefined) child.stdin?.end(input);
  });

// Simulate a `git push` landing: a commit made by another process, bypassing the store.
const externalCommit = async (
  dir: string,
  path: string,
  content: string,
  mode = '100644'
): Promise<void> => {
  const blob = (await runGit(dir, ['hash-object', '-w', '--stdin'], content)).trim();
  const parent = (await runGit(dir, ['rev-parse', 'refs/heads/main'])).trim();
  const idx = join(tmpdir(), `ext-idx-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: idx };
  await runGit(dir, ['read-tree', parent], undefined, env);
  await runGit(
    dir,
    ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`],
    undefined,
    env
  );
  const tree = (await runGit(dir, ['write-tree'], undefined, env)).trim();
  const commit = (await runGit(dir, ['commit-tree', tree, '-m', 'ext', '-p', parent])).trim();
  await runGit(dir, ['update-ref', 'refs/heads/main', commit]);
  await rm(idx, { force: true });
};

let currentRepo = '';
const makeRepoDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'bare-git-store-'));
  currentRepo = join(dir, 'vault.git');
  return currentRepo;
};

contractSuite({
  name: 'bare-git-store',
  make: async () => createBareGitStore(await makeRepoDir()),
  mutateExternally: async () => {
    await externalCommit(currentRepo, 'pushed.md', 'pushed from outside');
    return ['pushed.md'];
  },
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
  });
});

describe('validateBareRepoTree', () => {
  it('flags symlinks, reserved paths, and oversized blobs; clean tree passes', async () => {
    const repo = await makeRepoDir();
    const s = createBareGitStore(repo);
    await s.write({ path: 'fine.md', body: 'ok' });
    expect(await validateBareRepoTree(repo)).toEqual([]);

    await externalCommit(repo, 'link.md', 'target', '120000');
    await externalCommit(repo, '.agentage/hooks.json', '{}');
    const violations = await validateBareRepoTree(repo, { maxBytes: 1 });
    const byPath = new Map(violations.map((v) => [v.path, v.kind]));
    expect(byPath.get('link.md')).toBe('non-file-mode');
    expect(byPath.get('.agentage/hooks.json')).toBe('unsafe-path');
    expect(byPath.get('fine.md')).toBe('oversized'); // 2 bytes > maxBytes 1
  });
});
