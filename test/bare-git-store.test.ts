import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractSuite } from '../src/conformance/contract-suite.js';
import { securitySuite } from '../src/conformance/security-suite.js';
import { createBareGitStore, validateBareRepoTree } from '../src/index.js';

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

describe('bare-git-store: spawn budget', () => {
  it('warm verbs hold the pinned budget: read<=1, search<=2, list=0, version=0', async () => {
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
