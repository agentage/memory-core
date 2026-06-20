import type {
  EditInput,
  ListQuery,
  ListResult,
  MemoryView,
  SearchQuery,
  SearchResult,
  WriteAuthor,
  WriteInput,
  WriteResult,
} from '../contract/types.js';

// THE extension seam. The per-vault storage contract (a backend is already one
// vault, so there is no memoryId arg). New capabilities = new backends behind this
// interface, never new public surface.
export interface VaultBackend {
  search(q: SearchQuery): Promise<SearchResult>;
  read(path: string): Promise<MemoryView | null>; // null = not found
  list(q: ListQuery): Promise<ListResult>;
  write(i: WriteInput, author?: WriteAuthor): Promise<WriteResult>;
  edit(i: EditInput, author?: WriteAuthor): Promise<WriteResult | null>; // null = not found
  delete(path: string): Promise<boolean>; // false = not found
  capabilities(): BackendCapabilities;
}

export interface BackendCapabilities {
  kind: 'local' | 'remote';
  mutate: boolean;
  search: 'git-grep' | 'remote';
}
