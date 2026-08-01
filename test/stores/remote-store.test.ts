import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contractSuite } from '../../src/conformance/contract-suite.js';
import { securitySuite } from '../../src/conformance/security-suite.js';
import { createBareGitStore, createRemoteStore } from '../../src/index.js';
import { createStoreHandler } from '../../src/stores/remote/store-server.js';

const TOKEN = 'test-token-123';
const servers: Server[] = [];

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

// Full chain under test: remote client -> HTTP -> reference handler -> bare git repo.
const make = async () => {
  const base = await mkdtemp(join(tmpdir(), 'remote-store-'));
  currentRepo = join(base, 'vault.git');
  const backing = createBareGitStore(currentRepo);
  const server = createServer(createStoreHandler(backing, { token: TOKEN }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return createRemoteStore(`http://127.0.0.1:${port}`, TOKEN);
};

afterAll(() => {
  for (const s of servers) s.close();
});

contractSuite({
  name: 'remote-store',
  make,
  mutateExternally: async () => {
    await externalCommit(currentRepo, 'pushed.md', 'pushed from outside');
    return ['pushed.md'];
  },
});

securitySuite({ name: 'remote-store', make });

describe('remote-store: wire specifics', () => {
  it('rejects a bad bearer token', async () => {
    const base = await mkdtemp(join(tmpdir(), 'remote-auth-'));
    const backing = createBareGitStore(join(base, 'v.git'));
    const server = createServer(createStoreHandler(backing, { token: 'right' }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, r));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const wrong = createRemoteStore(`http://127.0.0.1:${port}`, 'wrong');
    await expect(wrong.read('a.md')).rejects.toThrow(/bad token/);
  });

  it('accepts an async token provider (expiring OAuth tokens)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'remote-provider-'));
    const backing = createBareGitStore(join(base, 'v.git'));
    const server = createServer(createStoreHandler(backing, { token: 'fresh' }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, r));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    let mints = 0;
    const s = createRemoteStore(`http://127.0.0.1:${port}`, async () => {
      mints++;
      return 'fresh';
    });
    await s.write({ path: 'a.md', body: 'x' });
    expect((await s.read('a.md'))!.body).toBe('x');
    expect(mints).toBeGreaterThanOrEqual(2); // minted per call, not cached forever
  });

  it('rejects an unknown wire version with a typed error', async () => {
    const s = await make();
    await s.write({ path: 'w.md', body: 'x' });
    const url = (s as unknown as { _url?: string })._url; // not exposed - use raw fetch below
    void url;
    const base = await mkdtemp(join(tmpdir(), 'remote-wire-'));
    const backing = createBareGitStore(join(base, 'v.git'));
    const server = createServer(createStoreHandler(backing, { token: 'tk' }));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, r));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/version`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tk',
        'x-store-wire': '99',
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('wire_version');
  });

  it('typed error codes survive the wire', async () => {
    const s = await make();
    await expect(s.write({ path: '../escape.md', body: 'x' })).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });

  it('canonical error strings survive the wire (str_replace contract)', async () => {
    const s = await make();
    await s.write({ path: 'n.md', body: 'alpha' });
    await expect(
      s.edit({ path: 'n.md', mode: 'str_replace', old_str: 'zzz', new_str: 'y' })
    ).rejects.toThrow(/No replacement was performed, old_str `zzz` did not appear verbatim/);
  });

  it('server-side events re-emit on the client (hooks work remotely)', async () => {
    const s = await make();
    const types: string[] = [];
    s.subscribe((e) => types.push(e.type));
    await s.write({ path: 'a.md', body: 'x' });
    await externalCommit(currentRepo, 'b.md', 'pushed');
    await s.refresh();
    await s.delete('a.md');
    expect(types).toEqual(['write', 'external', 'delete']);
  });
});
