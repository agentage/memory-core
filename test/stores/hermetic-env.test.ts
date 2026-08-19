// The engine must not inherit the host's git setup: identical results on a
// machine whose global gitconfig is actively hostile (renamed identity, content
// filters, and a hooks dir that rejects every ref update). Each test runs with
// that config exported to THIS process - the same ambient state a server would
// have - and asserts the engine behaves exactly as on a clean machine.

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleRepo, createBareGitStore, validateBareRepoTree } from '../../src/index.js';

const CRLF_BODY = 'first line\r\nsecond line\r\ntrailing spaces   ';

const git = (args: string[], env: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('git', args, { env }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  );

// Reading assertions must not be colored by the hostile config either.
const cleanEnv = (repo: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  GIT_DIR: repo,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
});

const newRepo = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), 'hermetic-')), 'vault.git');

let savedGlobal: string | undefined;

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), 'hostile-home-'));
  const hooks = join(home, 'hooks');
  await mkdir(hooks);
  const hook = join(hooks, 'reference-transaction');
  await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8');
  await chmod(hook, 0o755);
  const config = join(home, 'gitconfig');
  await writeFile(
    config,
    [
      '[user]',
      '\tname = hostile',
      '\temail = hostile@evil.test',
      '[core]',
      '\tautocrlf = true',
      '\tquotepath = false',
      `\thooksPath = ${hooks}`,
      '[commit]',
      '\tgpgsign = true',
      '',
    ].join('\n'),
    'utf8'
  );
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
});

afterAll(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
});

describe('bare-git store: hermetic environment', () => {
  it('the hostile config IS in effect - an env-inheriting spawn adopts it', async () => {
    expect((await git(['config', '--get', 'user.name'], process.env)).trim()).toBe('hostile');

    const repo = await newRepo();
    const store = createBareGitStore(repo);
    await store.write({ path: 'seed.md', body: 'x' }); // engine writes fine...
    const head = (await git(['rev-parse', 'refs/heads/main'], cleanEnv(repo))).trim();
    // ...while the same ref op with the ambient env dies in the hostile hook.
    await expect(
      git(['update-ref', 'refs/heads/probe', head], { ...process.env, GIT_DIR: repo })
    ).rejects.toThrow();
  });

  it('write/read round-trips byte-identically and takes its author from params', async () => {
    const repo = await newRepo();
    const store = createBareGitStore(repo);
    await store.write(
      { path: 'notes/crlf.md', body: CRLF_BODY },
      { id: 'claude-desktop', name: 'Claude' }
    );

    expect((await store.read('notes/crlf.md'))!.body).toBe(CRLF_BODY);
    expect(await git(['cat-file', 'blob', 'refs/heads/main:notes/crlf.md'], cleanEnv(repo))).toBe(
      CRLF_BODY
    );
    const who = (await git(['log', '-1', '--format=%an|%ae|%cn|%ce'], cleanEnv(repo))).trim();
    expect(who).toBe(
      'Claude|claude-desktop@clients.agentage.io|agentage memory|memory@agentage.io'
    );
  });

  it('the git-backed views agree with the bytes: describe, tree validation, bundle', async () => {
    const repo = await newRepo();
    const store = createBareGitStore(repo);
    await store.write({ path: 'notes/crlf.md', body: CRLF_BODY });
    await store.write({ path: 'plain.md', body: 'ascii' });

    const described = await store.describe();
    expect(described).toMatchObject({
      files: 2,
      folders: 1,
      sizeBytes: Buffer.byteLength(CRLF_BODY, 'utf8') + 'ascii'.length,
    });
    expect(await validateBareRepoTree(repo)).toEqual([]);
    const bundle = await bundleRepo(repo);
    expect(bundle!.subarray(0, 15).toString('utf8')).toBe('# v2 git bundle');
  });
});
