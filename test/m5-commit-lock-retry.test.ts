import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalBackend } from '../src/backends/local-backend.js';
import { isIndexLockError, withIndexLockRetry } from '../src/backends/git.js';
import { tmpVault } from './fixtures/index.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The exact stderr git emits when another process holds `.git/index.lock`.
const LOCK_MSG =
  "fatal: Unable to create '/x/.git/index.lock': File exists.\n\n" +
  'Another git process seems to be running in this repository, e.g.\n' +
  "an editor opened by 'git status'. Please make sure all processes are terminated";

describe('isIndexLockError classification', () => {
  it('matches the real index.lock stderr', () => {
    expect(isIndexLockError(new Error(`Command failed: git commit\n${LOCK_MSG}`))).toBe(true);
  });

  it('matches the "another git process" wording alone', () => {
    expect(isIndexLockError(new Error('Another git process seems to be running'))).toBe(true);
  });

  it('reads a separate stderr property too', () => {
    const err = Object.assign(new Error('Command failed: git commit'), { stderr: LOCK_MSG });
    expect(isIndexLockError(err)).toBe(true);
  });

  it('is false for any non-lock error and non-Errors', () => {
    expect(isIndexLockError(new Error('fatal: pathspec did not match'))).toBe(false);
    expect(isIndexLockError('index.lock as a string, not an Error')).toBe(false);
    expect(isIndexLockError(undefined)).toBe(false);
  });
});

describe('withIndexLockRetry bounded backoff', () => {
  it('retries a lock error then returns the success', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await withIndexLockRetry(
      async () => {
        if (calls++ === 0) throw new Error(LOCK_MSG);
        return 'ok';
      },
      async (ms) => void waits.push(ms)
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(waits).toEqual([50]);
  });

  it('fails fast on a non-lock error - no retry, no wait', async () => {
    let calls = 0;
    const waits: number[] = [];
    await expect(
      withIndexLockRetry(
        async () => {
          calls++;
          throw new Error('fatal: some other git failure');
        },
        async (ms) => void waits.push(ms)
      )
    ).rejects.toThrow('some other git failure');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('is bounded: a permanent lock surfaces the error after 5 retries', async () => {
    let calls = 0;
    const waits: number[] = [];
    await expect(
      withIndexLockRetry(
        async () => {
          calls++;
          throw new Error(LOCK_MSG);
        },
        async (ms) => void waits.push(ms)
      )
    ).rejects.toThrow(/index\.lock/);
    expect(calls).toBe(6); // 1 initial + 5 retries
    expect(waits).toEqual([50, 100, 150, 200, 250]);
  });
});

const lockPath = (root: string): string => join(root, '.git', 'index.lock');

describe('LocalBackend commit under index.lock contention', () => {
  it('a write succeeds once a transient lock is released mid-retry', async () => {
    const root = tmpVault({ 'seed.md': 'x' });
    const b = createLocalBackend({ path: root });
    const lock = lockPath(root);
    writeFileSync(lock, '', 'utf8'); // stand in for a concurrent git holding the index
    setTimeout(() => void rm(lock, { force: true }), 120);
    const w = await b.write({ path: 'a.md', body: 'hello' });
    expect(w.rev).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(lock)).toBe(false);
    expect((await b.read('a.md'))!.body).toBe('hello');
  });

  it('surfaces the lock error without hanging when the index stays locked', async () => {
    const root = tmpVault({ 'seed.md': 'x' });
    const b = createLocalBackend({ path: root });
    writeFileSync(lockPath(root), '', 'utf8');
    const start = Date.now();
    await expect(b.write({ path: 'a.md', body: 'hello' })).rejects.toThrow(
      /index\.lock|another git process/i
    );
    expect(Date.now() - start).toBeLessThan(3000); // ~750ms backoff + git spawns, well bounded
  });

  it('no-op write short-circuit is unaffected (byte-identical rewrite makes no commit)', async () => {
    const root = tmpVault();
    const b = createLocalBackend({ path: root });
    const first = await b.write({ path: 'n.md', body: 'same', frontmatter: { k: 'v' } });
    const again = await b.write({ path: 'n.md', body: 'same', frontmatter: { k: 'v' } });
    expect(again.rev).toBe(first.rev); // no new commit
  });

  it('N concurrent writes all land despite an external process cycling the index lock', async () => {
    const root = tmpVault({ 'seed.md': 'x' });
    const b = createLocalBackend({ path: root });
    const lock = lockPath(root);
    let stop = false;
    // Stand in for the sync cycle: grab .git/index.lock briefly then release, on repeat.
    // Exclusive-create means we only ever remove a lock WE placed, never git's live one.
    const churn = (async () => {
      while (!stop) {
        let held = false;
        try {
          writeFileSync(lock, '', { flag: 'wx' });
          held = true;
        } catch {
          // git (or a prior grab) holds it - back off and retry.
        }
        if (held) {
          await sleep(5); // hold the index briefly, like a real commit
          await rm(lock, { force: true });
          await sleep(40); // then leave it free - the window a retry lands in
        } else {
          await sleep(10);
        }
      }
    })();
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => b.write({ path: `n${i}.md`, body: `body ${i}` }))
    );
    stop = true;
    await churn;
    await rm(lock, { force: true });
    expect(results).toHaveLength(N);
    for (const r of results) expect(r.rev).toMatch(/^[0-9a-f]{40}$/);
    for (let i = 0; i < N; i++) expect((await b.read(`n${i}.md`))!.body).toBe(`body ${i}`);
  });
});
