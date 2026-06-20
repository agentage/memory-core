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

// THE extension seam. Byte-identical to the server's MemoryStore, minus the
// memoryId arg (a backend is already one vault). New capabilities = new backends
// behind this interface, never new public surface (requirements: the one principle).
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
