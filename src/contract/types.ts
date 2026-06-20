// The memory contract: the data shapes for documents, search/list queries and
// results, plus the vaults.json config shape. The VaultBackend interface
// (src/backends) is the per-vault projection of this contract - the one extension seam.

export interface WriteInput {
  path: string;
  body: string;
  frontmatter?: Record<string, unknown>;
}

export interface EditInput {
  path: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
  // snake_case mirrors the tool wire keys; inputs pass through verbatim.
  mode?: 'replace' | 'append' | 'str_replace';
  old_str?: string;
  new_str?: string;
}

export interface WriteResult {
  path: string;
  rev: string; // commit SHA - internal; stripped from the model-facing response
  updated: string;
}

// The connected client a write is attributed to (becomes the git author).
export interface WriteAuthor {
  id: string;
  name: string;
}

export interface MemoryView {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  tags: string[];
  updated: string;
  deleted: boolean;
}

export interface SearchQuery {
  query: string;
  folder?: string;
  tags?: string[];
  limit?: number;
  cursor?: string;
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

export interface ListQuery {
  folder?: string;
  depth?: 1 | 2;
  tags?: string[];
}

export interface TreeFile {
  type: 'file';
  path: string;
  title: string;
  updated: string;
}

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
}

// ---- config (~/.agentage/vaults.json) ----
export type McpScope = 'local' | 'remote';

export interface Origin {
  remote: string;
  interval?: number;
  ignore?: string[];
}

export interface VaultEntry {
  origin?: Origin[];
  path?: string;
  mcp?: McpScope[];
}

export interface VaultsConfig {
  $schema?: string;
  version: 1;
  // Base directory whose immediate subfolders become vaults when `autodiscover` is on
  // (drop a folder in -> it's a vault). Explicit `vaults` entries override/augment it.
  vaultsDir?: string;
  autodiscover?: boolean;
  // Auto-create a missing vault folder (and git-init it) on first use. Default true.
  autoInit?: boolean;
  default?: string;
  vaults?: Record<string, VaultEntry>;
}
