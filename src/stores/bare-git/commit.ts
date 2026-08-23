// Plumbing commit with compare-and-swap: read HEAD as expected parent, build the
// tree in a throwaway index, commit-tree, advance refs/heads/main only if the
// parent still matches. The per-store mutex serializes same-process writers; the
// CAS + bounded retry covers cross-process races so a concurrent writer never
// causes a lost update.

import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WriteAuthor } from '../../contract/types.js';
import type { GitRunner } from './git-run.js';

const ZERO_OID = '0'.repeat(40);
const MAX_CAS_RETRIES = 5;
// A live update-ref holds the ref-lock for ms; older means a crashed writer.
const STALE_LOCK_MS = 10_000;

export interface TreeChange {
  path: string;
  blobSha?: string;
  remove?: boolean;
}

// Remove a ref-lock stranded by an update-ref killed mid-write - without this,
// every future write to the one vault fails `cannot lock ref` until an operator
// intervenes. Never yanks a lock a live writer is briefly holding.
const clearStaleLock = async (gitDir: string): Promise<void> => {
  const lock = join(gitDir, 'refs', 'heads', 'main.lock');
  try {
    if (Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true });
  } catch {
    // no lock or already gone
  }
};

const buildTree = async (
  git: GitRunner,
  parent: string | null,
  change: TreeChange
): Promise<string> => {
  const indexFile = join(tmpdir(), `store-idx-${randomUUID()}`);
  try {
    if (parent) await git.run(['read-tree', parent], { indexFile });
    if (change.remove) {
      // mode 0 removes the entry; `--force-remove` would need a work tree.
      await git.run(['update-index', '--index-info'], {
        indexFile,
        input: `0 ${ZERO_OID}\t${change.path}\n`,
      });
    } else {
      await git.run(
        ['update-index', '--add', '--cacheinfo', `100644,${change.blobSha},${change.path}`],
        { indexFile }
      );
    }
    return (await git.run(['write-tree'], { indexFile })).trim();
  } finally {
    await rm(indexFile, { force: true });
  }
};

export const commitChange = async (
  git: GitRunner,
  gitDir: string,
  change: TreeChange,
  message: string,
  ts: string,
  author?: { name: string; email: string }
): Promise<string> => {
  for (let attempt = 0; ; attempt++) {
    const parent = await git.readVersion();
    const tree = await buildTree(git, parent, change);
    const args = ['commit-tree', tree, '-m', message, ...(parent ? ['-p', parent] : [])];
    const commit = (await git.run(args, { date: ts, author })).trim();
    try {
      await git.run(['update-ref', 'refs/heads/main', commit, parent ?? ZERO_OID]);
      return commit;
    } catch (err) {
      if (attempt >= MAX_CAS_RETRIES) throw err;
      await clearStaleLock(gitDir);
    }
  }
};

// The client address is this store's ONE attribution encoding, and both directions
// live here so history can be read back as the write that made it.
export const CLIENT_EMAIL_SUFFIX = '@clients.agentage.io';

// The git author identity for an attributed write: stable email-safe address
// from the authenticated client id (what the dashboard groups by).
export const gitAuthorOf = (author?: WriteAuthor): { name: string; email: string } | undefined =>
  author
    ? {
        name: author.name,
        email: `${author.id.replace(/[^a-zA-Z0-9._-]/g, '-')}${CLIENT_EMAIL_SUFFIX}`,
      }
    : undefined;

// The inverse. Anything else authored the commit - the system identity on an
// unattributed write, or a human's own identity on a pushed one - so it belongs to
// no client and reads back as undefined.
export const clientAuthorOf = (name: string, email: string): WriteAuthor | undefined =>
  email.endsWith(CLIENT_EMAIL_SUFFIX)
    ? { id: email.slice(0, -CLIENT_EMAIL_SUFFIX.length), name }
    : undefined;
