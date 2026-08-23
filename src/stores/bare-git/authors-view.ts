// The commit log, read only for what attribution needs. `git log` is already the
// history: memory-mcp stamps the connected client as the git AUTHOR and leaves the
// committer to the system, so reading the author back is the exact inverse of
// gitAuthorOf - no second bookkeeping, and a store that was restored from a clone
// answers the same as the one that wrote it.
//
// ONE spawn over the whole history, which is why the store caches the result by
// version exactly as it caches the vault card.

import { recordAuthored, rankAuthors, type AuthorTally } from '../../contract/authorship.js';
import type { AuthorStat } from '../../contract/types.js';
import { clientAuthorOf } from './commit.js';
import type { GitRunner } from './git-run.js';

// A unit separator cannot occur in a name, an address or a date, so the line
// splits without quoting whatever a client called itself.
const SEP = '\x1f';
const FORMAT = `--format=%aN${SEP}%aE${SEP}%cI`;

export const readAuthors = async (git: GitRunner, version: string): Promise<AuthorStat[]> => {
  // Same ref the caller asked about, never HEAD: a push mid-read must not blend
  // two versions into one answer. `--reverse` feeds the tally chronologically, the
  // order its tie rule is written for.
  const out = await git.tryRun(['log', '--reverse', FORMAT, version]);
  if (out === null) return [];
  const tally: AuthorTally = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [name = '', email = '', at = ''] = line.split(SEP);
    const author = clientAuthorOf(name, email);
    if (author) recordAuthored(tally, author, at);
  }
  return rankAuthors(tally);
};
