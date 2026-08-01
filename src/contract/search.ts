// Search semantics defined ONCE: fixed-string case-insensitive matching, score =
// occurrence count, recency tiebreak, folder/tags filter, cursor pagination.
// Stores supply candidate hits however they find them (grep, index, scan); the
// ranking and paging contract never diverges between implementations.

import { decodeCursor, encodeCursor } from './cursor.js';
import { makeSnippet, titleFromPath } from './memory-doc.js';
import { normalizeFolder } from './tree.js';
import type { SearchQuery, SearchResult } from './types.js';

// Hard cap per page - a pathological limit can't unbound the scan.
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;

export { decodeCursor, encodeCursor } from './cursor.js';

// Non-overlapping, case-insensitive, fixed-string occurrence count (git grep -o -i -F).
export const countOccurrences = (text: string, query: string): number => {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  let n = 0;
  for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + q.length)) n++;
  return n;
};

// A candidate produced by a store's matcher, pre-snippet.
export interface RankedHit {
  path: string;
  score: number;
  tags: string[];
  body: string;
  updated: string;
}

export const rankAndPage = (hits: RankedHit[], query: SearchQuery): SearchResult => {
  const scope = normalizeFolder(query.folder);
  const scored = hits
    .filter((h) => h.score > 0)
    .filter((h) => (scope ? h.path.startsWith(`${scope}/`) : true))
    .filter((h) => (query.tags?.length ? query.tags.every((t) => h.tags.includes(t)) : true))
    // Deterministic total order: score desc, recency desc, then PATH asc - a
    // full tie must never fall back to input order (stores enumerate differently).
    .sort(
      (a, b) =>
        b.score - a.score || b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path)
    );
  const limit = Math.min(query.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const offset = decodeCursor(query.cursor);
  const results = scored.slice(offset, offset + limit).map((h) => ({
    path: h.path,
    title: titleFromPath(h.path),
    snippet: makeSnippet(h.body, query.query),
    score: h.score,
    updated: h.updated,
  }));
  const next = offset + limit;
  return next < scored.length ? { results, nextCursor: encodeCursor(next) } : { results };
};
