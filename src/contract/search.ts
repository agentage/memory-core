// Search semantics defined ONCE: fixed-string case-insensitive matching, score =
// occurrence count, recency tiebreak, folder/tags filter, cursor pagination.
// Stores supply candidate hits however they find them (grep, index, scan); the
// ranking and paging contract never diverges between implementations.

import { decodeCursor, encodeCursor } from './cursor.js';
import { deriveTags, makeSnippet, parseDoc, titleFromPath } from './memory-doc.js';
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

// The metadata a matcher can produce without opening the document. Enough to
// order and page; only the surviving page ever needs a body (for the snippet).
export interface LeanHit {
  path: string;
  score: number;
  updated: string;
}

// Order/filter/page - the single definition of the contract, body never touched.
const orderAndSlice = <T extends LeanHit & { tags?: string[] }>(
  hits: T[],
  query: SearchQuery
): { page: T[]; total: number; next: number } => {
  const scope = normalizeFolder(query.folder);
  const scored = hits
    .filter((h) => h.score > 0)
    .filter((h) => (scope ? h.path.startsWith(`${scope}/`) : true))
    .filter((h) => (query.tags?.length ? query.tags.every((t) => h.tags?.includes(t)) : true))
    // Deterministic total order: score desc, recency desc, then PATH asc - a
    // full tie must never fall back to input order (stores enumerate differently).
    .sort(
      (a, b) =>
        b.score - a.score || b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path)
    );
  const limit = Math.min(query.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const offset = decodeCursor(query.cursor);
  return { page: scored.slice(offset, offset + limit), total: scored.length, next: offset + limit };
};

const page = (
  hits: { path: string; score: number; updated: string; body: string }[],
  query: SearchQuery,
  total: number,
  next: number
): SearchResult => {
  const results = hits.map((h) => ({
    path: h.path,
    title: titleFromPath(h.path),
    snippet: makeSnippet(h.body, query.query),
    score: h.score,
    updated: h.updated,
  }));
  return next < total ? { results, nextCursor: encodeCursor(next) } : { results };
};

export const rankAndPage = (hits: RankedHit[], query: SearchQuery): SearchResult => {
  const { page: slice, total, next } = orderAndSlice(hits, query);
  return page(slice, query, total, next);
};

// Same contract, deferred read: rank on matcher metadata and fetch documents for
// the surviving page only. A tags filter needs every candidate's frontmatter, so
// that case hydrates in full and falls back to the eager path - identical output,
// the win is the common (untagged) query on a store where a read costs IO.
export const rankAndPageDeferred = async (
  hits: LeanHit[],
  query: SearchQuery,
  hydrate: (paths: string[]) => Promise<Map<string, string>>
): Promise<SearchResult> => {
  if (query.tags?.length) {
    const docs = await hydrate(hits.map((h) => h.path));
    return rankAndPage(
      hits.map((h) => {
        const { frontmatter, body } = parseDoc(docs.get(h.path) ?? '');
        return { ...h, tags: deriveTags(frontmatter, body), body };
      }),
      query
    );
  }
  const { page: slice, total, next } = orderAndSlice(hits, query);
  const docs = await hydrate(slice.map((h) => h.path));
  return page(
    slice.map((h) => ({ ...h, body: parseDoc(docs.get(h.path) ?? '').body })),
    query,
    total,
    next
  );
};
