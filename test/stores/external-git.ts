// Changes made by ANOTHER process - what a `git push` landing looks like to a
// running store. Plumbing only: no working tree, no store involvement, and a
// throwaway index so the repo's own index is never touched.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ZERO_OID = '0'.repeat(40);

export const runGit = (
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

export interface ExternalChange {
  path: string;
  content?: string;
  mode?: string;
  remove?: boolean;
}

// One commit carrying every change at once - the shape a real push has when a
// client renames or reorganizes files.
export const externalCommit = async (
  dir: string,
  changes: ExternalChange[],
  message = 'ext',
  // Commit dates have SECOND precision; a proof about dates must state them.
  date?: string
): Promise<string> => {
  const parent = (await runGit(dir, ['rev-parse', 'refs/heads/main'])).trim();
  const idx = join(tmpdir(), `ext-idx-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    await runGit(dir, ['read-tree', parent], undefined, env);
    for (const change of changes) {
      if (change.remove) {
        await runGit(dir, ['update-index', '--index-info'], `0 ${ZERO_OID}\t${change.path}\n`, env);
        continue;
      }
      const blob = (await runGit(dir, ['hash-object', '-w', '--stdin'], change.content)).trim();
      await runGit(
        dir,
        [
          'update-index',
          '--add',
          '--cacheinfo',
          `${change.mode ?? '100644'},${blob},${change.path}`,
        ],
        undefined,
        env
      );
    }
    const tree = (await runGit(dir, ['write-tree'], undefined, env)).trim();
    const stamps: Record<string, string> = date
      ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : {};
    const commit = (
      await runGit(dir, ['commit-tree', tree, '-m', message, '-p', parent], undefined, stamps)
    ).trim();
    await runGit(dir, ['update-ref', 'refs/heads/main', commit]);
    return commit;
  } finally {
    await rm(idx, { force: true });
  }
};

// A force-push / reset: the ref moves to a commit that is NOT a descendant.
export const forceRef = async (dir: string, commit: string): Promise<void> => {
  await runGit(dir, ['update-ref', 'refs/heads/main', commit]);
};
