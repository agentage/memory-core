import { execFile } from 'node:child_process';
import type { WriteAuthor } from '../contract/types.js';

const SEARCH_TIMEOUT_MS = 5_000;

// 50ms steps capped at 250ms -> up to 5 retries (~750ms) before surfacing the lock error.
const LOCK_BACKOFFS_MS = [50, 100, 150, 200, 250];
const LOCK_RE = /index\.lock|another git process seems to be running/i;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// True only for the transient `.git/index.lock` contention (a concurrent git process
// held the index), never for a real git failure - so a retry can never mask a genuine error.
export const isIndexLockError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const text = `${err.message} ${(err as { stderr?: string }).stderr ?? ''}`;
  return LOCK_RE.test(text);
};

// Run a git mutation, retrying with a short bounded backoff only while the index is
// locked by another process; any non-lock error (and a still-locked final attempt) throws.
export const withIndexLockRetry = async <T>(
  op: () => Promise<T>,
  wait: (ms: number) => Promise<void> = sleep
): Promise<T> => {
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (err) {
      if (i >= LOCK_BACKOFFS_MS.length || !isIndexLockError(err)) throw err;
      await wait(LOCK_BACKOFFS_MS[i]);
    }
  }
};

export interface GitRunOpts {
  date?: string;
  author?: WriteAuthor;
  timeoutMs?: number;
}

// git bound to one working-tree repo (cwd). Author = the connected client when
// attributed; committer is always the local user (system git identity applies).
export interface Git {
  run(args: string[], opts?: GitRunOpts): Promise<string>;
  try(args: string[], opts?: GitRunOpts): Promise<string | null>;
}

export const createGit = (cwd: string): Git => {
  const exec = (args: string[], opts: GitRunOpts): Promise<string> =>
    new Promise((resolve, reject) => {
      // Always set a full identity so commits never depend on the user's ambient git
      // config (which is absent on CI runners and on a fresh machine). A supplied author
      // overrides the author identity; the committer is always the local app identity.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: opts.author?.name ?? 'agentage memory',
        GIT_AUTHOR_EMAIL: opts.author
          ? `${opts.author.id.replace(/[^a-zA-Z0-9._-]/g, '-')}@clients.agentage.io`
          : 'memory@agentage.io',
        GIT_COMMITTER_NAME: 'agentage memory',
        GIT_COMMITTER_EMAIL: 'memory@agentage.io',
      };
      if (opts.date) {
        env.GIT_AUTHOR_DATE = opts.date;
        env.GIT_COMMITTER_DATE = opts.date;
      }
      execFile(
        'git',
        args,
        { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 0 },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      );
    });

  return {
    run: (args, opts = {}) => exec(args, opts),
    try: async (args, opts = {}) => {
      try {
        return await exec(args, opts);
      } catch {
        return null;
      }
    },
  };
};

export const SEARCH_TIMEOUT = SEARCH_TIMEOUT_MS;
