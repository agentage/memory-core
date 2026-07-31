// Pure helpers shared by every store impl: how a path becomes a title, how tags
// are derived (DM5/DM6), how a doc serializes, and how a search snippet is cut.
// Kept storage-agnostic.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

// Split a stored .md into YAML frontmatter + body. Malformed/absent frontmatter
// yields empty frontmatter + the raw content as body (never throws).
export const parseDoc = (
  content: string
): { frontmatter: Record<string, unknown>; body: string } => {
  const m = content.match(FRONTMATTER);
  if (!m) return { frontmatter: {}, body: content };
  try {
    const parsed = parseYaml(m[1] ?? '') as unknown;
    const frontmatter =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return { frontmatter, body: m[2] ?? '' };
  } catch {
    return { frontmatter: {}, body: content };
  }
};

// The on-disk document shape; read responses stay byte-identical to the stored
// .md (files-first promise). Empty frontmatter emits the bare body, no fences.
export const serializeDoc = (frontmatter: Record<string, unknown>, body: string): string =>
  Object.keys(frontmatter).length === 0 ? body : `---\n${stringifyYaml(frontmatter)}---\n${body}`;

// Title = filename stem, never a frontmatter `title` (DM5 Obsidian fidelity).
export const titleFromPath = (path: string): string => {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
};

const normalizeTag = (tag: string): string => tag.replace(/^#/, '').trim();

// Indexed tags = union(frontmatter `tags`, inline `#tags`), numeric-only dropped (DM6).
export const deriveTags = (frontmatter: Record<string, unknown>, body: string): string[] => {
  const fromFm = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((t): t is string => typeof t === 'string')
    : [];

  const fromBody: string[] = [];
  for (const match of body.matchAll(INLINE_TAG)) if (match[1]) fromBody.push(match[1]);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...fromFm, ...fromBody]) {
    const tag = normalizeTag(raw);
    if (!tag || /^\d+$/.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
};

// Leading ~200-char preview of the body (no markup, no match anchor). Empty body -> ''.
export const makeExcerpt = (body: string, length = 200): string => {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

// ~200-char window around the first match, no markup.
export const makeSnippet = (body: string, query: string, length = 200): string => {
  const flat = body.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, length);
  const start = Math.max(0, at - Math.floor(length / 2));
  const slice = flat.slice(start, start + length);
  return (start > 0 ? '…' : '') + slice + (start + length < flat.length ? '…' : '');
};
