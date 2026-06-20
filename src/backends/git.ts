import { execFile } from 'node:child_process';
import type { WriteAuthor } from '../contract/types.js';

const SEARCH_TIMEOUT_MS = 5_000;

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
