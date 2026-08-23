// The aggregation behind `authors()`. Every store keeps its own history in its own
// shape - git keeps commits, the in-memory store keeps a tally - so what has to be
// shared is the ARITHMETIC and the ORDER, not the storage. Both stores fill the same
// accumulator and rank it here, which is why their answers are comparable at all.

import type { AuthorStat, WriteAuthor } from './types.js';

export interface AuthorRecord {
  name: string;
  writes: number;
  lastAt: string;
}

// Keyed by the client id a write carried - the one identity a store must preserve.
export type AuthorTally = Map<string, AuthorRecord>;

// `writes` is order-independent. `lastAt` and the client's name come from the latest
// change, and a store dates to the second, so ties are real: they go to the LAST
// record fed. Both stores therefore feed CHRONOLOGICALLY, which makes "latest wins"
// mean the same thing whether the history is a live tally or a `git log --reverse`.
export const recordAuthored = (tally: AuthorTally, author: WriteAuthor, at: string): void => {
  const seen = tally.get(author.id);
  if (!seen) {
    tally.set(author.id, { name: author.name, writes: 1, lastAt: at });
    return;
  }
  seen.writes += 1;
  const held = Date.parse(seen.lastAt);
  const next = Date.parse(at);
  // Take the newer change, ties included - but a stamp that is no date at all never
  // displaces a real one, in either direction.
  if (!Number.isNaN(next) && !(next < held)) {
    seen.lastAt = at;
    seen.name = author.name;
  }
};

// PINNED ORDER: busiest first, then id ascending. A total order that never reads a
// clock, so two stores holding the same history agree even when their timestamps
// differ in precision. Presentation order (recency, activity) is a host concern.
export const rankAuthors = (tally: AuthorTally): AuthorStat[] =>
  [...tally]
    .map(([id, r]) => ({ author: { id, name: r.name }, writes: r.writes, lastAt: r.lastAt }))
    .sort((a, b) => b.writes - a.writes || a.author.id.localeCompare(b.author.id));
