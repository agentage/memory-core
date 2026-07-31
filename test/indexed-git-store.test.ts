import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractSuite } from '../src/conformance/contract-suite.js';
import { securitySuite } from '../src/conformance/security-suite.js';
import { createIndexedGitStore } from '../src/index.js';

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

const externalCommit = async (dir: string, path: string, content: string): Promise<void> => {
  const blob = (await runGit(dir, ['hash-object', '-w', '--stdin'], content)).trim();
  const parent = (await runGit(dir, ['rev-parse', 'refs/heads/main'])).trim();
  const idx = join(tmpdir(), `idx-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: idx };
  await runGit(dir, ['read-tree', parent], undefined, env);
  await runGit(
    dir,
    ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`],
    undefined,
    env
  );
  const tree = (await runGit(dir, ['write-tree'], undefined, env)).trim();
  const commit = (await runGit(dir, ['commit-tree', tree, '-m', 'ext', '-p', parent])).trim();
  await runGit(dir, ['update-ref', 'refs/heads/main', commit]);
  await rm(idx, { force: true });
};

let currentRepo = '';
const make = async () => {
  const base = await mkdtemp(join(tmpdir(), 'indexed-store-'));
  currentRepo = join(base, 'vault.git');
  return createIndexedGitStore(currentRepo, join(base, '.cache'));
};

// The SAME conformance bar as every other store - swap-in proof.
contractSuite({
  name: 'indexed-git-store',
  make,
  mutateExternally: async () => {
    await externalCommit(currentRepo, 'pushed.md', 'pushed from outside');
    return ['pushed.md'];
  },
});

securitySuite({ name: 'indexed-git-store', make });

describe('indexed-git-store: index behavior', () => {
  it('finds content pushed out-of-band after refresh (event-driven index apply)', async () => {
    const s = await make();
    await s.write({ path: 'seed.md', body: 'seeded zebra' });
    expect((await s.search({ query: 'zebra', limit: 10 })).results).toHaveLength(1);
    await externalCommit(currentRepo, 'pushed.md', 'a wild zebra appears');
    await s.refresh();
    const hits = await s.search({ query: 'zebra', limit: 10 });
    expect(hits.results.map((r) => r.path).sort()).toEqual(['pushed.md', 'seed.md']);
  });

  it('substring queries still work via the grep fallback (recall never regresses)', async () => {
    const s = await make();
    await s.write({ path: 'a.md', body: 'kiwifruit salad' });
    // 'wifru' is a mid-token substring: FTS cannot match it, grep can.
    expect((await s.search({ query: 'wifru', limit: 10 })).results).toHaveLength(1);
  });

  it('hostile FTS syntax never throws and matches grep semantics', async () => {
    const s = await make();
    await s.write({ path: 'a.md', body: 'plain note about OR statements' });
    for (const q of ['" OR 1=1; --', 'NEAR(a b)', 'a" AND "b', '*', '(((', 'col:val']) {
      const res = await s.search({ query: q, limit: 10 });
      expect(Array.isArray(res.results), q).toBe(true);
    }
    expect((await s.search({ query: 'OR statements', limit: 10 })).results).toHaveLength(1);
  });

  it('a deleted index rebuilds silently from git (disposable derived state)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'indexed-rebuild-'));
    const repo = join(base, 'v.git');
    const cacheA = join(base, 'cache-a');
    const a = createIndexedGitStore(repo, cacheA);
    await a.write({ path: 'n.md', body: 'phoenix content' });
    expect((await a.search({ query: 'phoenix', limit: 5 })).results).toHaveLength(1);
    await rm(cacheA, { recursive: true, force: true });
    // A brand-new store on a brand-new index dir: cold reindex from git.
    const b = createIndexedGitStore(repo, join(base, 'cache-b'));
    expect((await b.search({ query: 'phoenix', limit: 5 })).results).toHaveLength(1);
  });
});
