// Flat note enumeration defined ONCE: cursor paging (same idiom as search),
// name-sorted, metadata read only for the page slice so cost is bounded by
// `limit`, never by vault size. Stores supply their path list and a batch
// reader; the shape never diverges between implementations.

import { deriveTags, makeExcerpt, parseDoc, titleFromPath } from './memory-doc.js';
import { decodeCursor, encodeCursor } from './search.js';
import { normalizeFolder } from './tree.js';
import type { ListNotesQuery, ListNotesResult, NoteMeta } from './types.js';

// Match the live /v1 wire (clampLimit defaults) so adapters are pass-through.
export const DEFAULT_NOTES_LIMIT = 200;
export const MAX_NOTES_LIMIT = 500;

export const pageNotes = async (
  allPaths: Iterable<string>,
  q: ListNotesQuery | undefined,
  readRawBatch: (page: string[]) => Promise<Map<string, string>>,
  mtimeOf: (path: string) => string | null
): Promise<ListNotesResult> => {
  const folder = normalizeFolder(q?.folder);
  const depth = q?.depth ?? -1; // -1 = full tree; 0 = direct notes only; N = N subfolder levels
  const inScope = (p: string): boolean => {
    if (folder && !p.startsWith(`${folder}/`)) return false;
    if (depth < 0) return true;
    const rel = folder ? p.slice(folder.length + 1) : p;
    return rel.split('/').length - 1 <= depth;
  };
  const paths = [...allPaths].filter(inScope).sort((a, b) => a.localeCompare(b));
  const total = paths.length;
  const limit = Math.min(Math.max(q?.limit ?? DEFAULT_NOTES_LIMIT, 1), MAX_NOTES_LIMIT);
  const offset = decodeCursor(q?.cursor);
  const page = paths.slice(offset, offset + limit);
  const raws = await readRawBatch(page);
  const notes: NoteMeta[] = page.map((path) => {
    const raw = raws.get(path) ?? '';
    const { frontmatter, body } = parseDoc(raw);
    return {
      path,
      title: titleFromPath(path),
      tags: deriveTags(frontmatter, body),
      excerpt: makeExcerpt(body),
      sizeBytes: Buffer.byteLength(raw, 'utf8'),
      updated: mtimeOf(path),
    };
  });
  const next = offset + limit;
  return next < total ? { notes, total, nextCursor: encodeCursor(next) } : { notes, total };
};
