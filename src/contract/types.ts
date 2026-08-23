// Wire types for the vault store contract. Shapes are frozen against the 6
// memory__* MCP tools and the /v1 REST surface - additive changes only.

export interface WriteInput {
  path: string;
  body: string;
  frontmatter?: Record<string, unknown>;
}

export interface EditInput {
  path: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
  mode: 'replace' | 'append' | 'str_replace';
  // snake_case mirrors the wire keys (ADR-009 D9.4); inputs pass through verbatim.
  old_str?: string;
  new_str?: string;
}

export interface ListQuery {
  folder?: string;
  depth?: number;
  tags?: string[];
  // Cursor paging over the name-sorted file set: each page is a tree-shaped
  // window; `files` always reports the TOTAL in scope. Default limit 500.
  limit?: number;
  cursor?: string;
}

export interface SearchQuery {
  query: string;
  folder?: string;
  tags?: string[];
  // Default 20, hard cap 50 (matches the live MCP tool schema default).
  limit?: number;
  cursor?: string;
}

// `rev` is an opaque version token - implementations decide what it is (git: commit
// sha; remote: ETag; in-memory: counter). The only promise: it changes iff content changed.
export interface WriteResult {
  path: string;
  rev: string;
  updated: string;
}

// The connected client a write is attributed to. `id` is the authenticated client id
// (stable); `name` is best-effort. Optional, so system writes stay unattributed.
export interface WriteAuthor {
  id: string;
  name: string;
}

// One connected client's write history in this vault - the read-only view of the
// attribution `write`/`edit` recorded. ATTRIBUTED changes only: a write with no
// author, and a change that arrived out of band, belong to no client and are in
// no row. `writes` and `lastAt` cover the history the store RETAINS (git: every
// commit; in-memory: what the instance has seen).
export interface AuthorStat {
  // The author as the write supplied it. `id` round-trips through whatever the
  // store addresses a client by, so a character that address cannot hold is lost.
  author: WriteAuthor;
  writes: number;
  // Strict ISO 8601 instant of the latest attributed change; second precision.
  lastAt: string;
}

export interface MemoryView {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  tags: string[];
  updated: string;
  deleted: boolean;
  // Exact stored byte size of the raw doc (pre-clamp), matching `git clone` on disk.
  sizeBytes?: number;
}

export interface VaultDescription {
  files: number;
  folders: number;
  sizeBytes: number;
  // Latest content change (commit/mtime semantics per store); null = empty vault.
  updated: string | null;
  // Same opaque token version() returns; null = empty vault.
  version: string | null;
}

export interface TreeFile {
  type: 'file';
  path: string;
  title: string;
  updated: string;
}

// `entries` is present when the folder is expanded (within depth and limits);
// `truncated: true` marks a folder that WOULD have been expanded but was refused.
export interface TreeFolder {
  type: 'folder';
  path: string;
  files: number;
  truncated?: boolean;
  entries?: TreeEntry[];
}

export type TreeEntry = TreeFile | TreeFolder;

export interface ListResult {
  folder: string;
  entries: TreeEntry[];
  truncated: boolean;
  files: number;
  nextCursor?: string;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  updated: string;
}

export interface SearchResult {
  results: SearchHit[];
  nextCursor?: string;
}
